import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ batchIngest: vi.fn() }));

// The real module builds a Chargebee client from env at import time.
vi.mock("@/plugins/chargebee-plugin", () => ({
  chargebeeClient: { usageEvent: { batchIngest: mocks.batchIngest } },
}));

import {
  MAX_DELIVERIES,
  MAX_EVENT_AGE_MS,
  ingestBatch,
  splitExhausted,
  splitExpired,
} from "./ingest";
import type { UsageStreamEntry } from "./stream";

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

function entry(
  id: string,
  overrides: { ageMs?: number; deliveries?: number } = {},
): UsageStreamEntry {
  return {
    id,
    deliveries: overrides.deliveries ?? 1,
    event: {
      deduplicationId: `dedup-${id}`,
      subscriptionId: "sub-1",
      usageTimestamp: NOW - (overrides.ageMs ?? 0),
      properties: {
        generation_id: `gen-${id}`,
        model: "openai/gpt-4o-mini",
        input_tokens: 10,
        output_tokens: 20,
        credits_consumed: 0,
        usage_source: "plan_quota",
        plan_id: "plan-pro",
      },
    },
  };
}

beforeEach(() => {
  mocks.batchIngest.mockReset();
});

describe("splitExpired", () => {
  it("keeps events inside the backdating window", () => {
    const { fresh, expired } = splitExpired(
      [entry("a"), entry("b", { ageMs: MAX_EVENT_AGE_MS - 1_000 })],
      NOW,
    );

    expect(fresh).toHaveLength(2);
    expect(expired).toHaveLength(0);
  });

  it("expires an hour before Chargebee's 12h cutoff", () => {
    expect(MAX_EVENT_AGE_MS).toBe(11 * 60 * 60 * 1_000);

    const { fresh, expired } = splitExpired(
      [entry("old", { ageMs: MAX_EVENT_AGE_MS + 1 }), entry("new")],
      NOW,
    );

    expect(expired.map((e) => e.id)).toEqual(["old"]);
    expect(fresh.map((e) => e.id)).toEqual(["new"]);
  });
});

describe("splitExhausted", () => {
  it("retries up to the delivery ceiling and parks beyond it", () => {
    const { retryable, exhausted } = splitExhausted([
      entry("first", { deliveries: 1 }),
      entry("last-chance", { deliveries: MAX_DELIVERIES }),
      entry("spent", { deliveries: MAX_DELIVERIES + 1 }),
    ]);

    expect(retryable.map((e) => e.id)).toEqual(["first", "last-chance"]);
    expect(exhausted.map((e) => e.id)).toEqual(["spent"]);
  });
});

describe("ingestBatch", () => {
  it("sends the Chargebee wire shape", async () => {
    mocks.batchIngest.mockResolvedValue({ batch_id: "b1", failed_events: [] });

    await ingestBatch([entry("a")]);

    expect(mocks.batchIngest).toHaveBeenCalledWith({
      events: [
        {
          deduplication_id: "dedup-a",
          subscription_id: "sub-1",
          usage_timestamp: NOW,
          properties: expect.objectContaining({ generation_id: "gen-a" }),
        },
      ],
    });
  });

  it("does not call Chargebee for an empty batch", async () => {
    const result = await ingestBatch([]);

    expect(mocks.batchIngest).not.toHaveBeenCalled();
    expect(result).toEqual({ batchId: null, ingested: [], failed: [] });
  });

  it("acknowledges the events that landed in a partial failure", async () => {
    mocks.batchIngest.mockResolvedValue({
      batch_id: "b2",
      failed_events: [{ deduplication_id: "dedup-b" }],
    });

    const result = await ingestBatch([entry("a"), entry("b"), entry("c")]);

    expect(result.ingested.map((e) => e.id)).toEqual(["a", "c"]);
    expect(result.failed.map((e) => e.id)).toEqual(["b"]);
  });

  it("reads a deduplication id nested under the echoed event", async () => {
    mocks.batchIngest.mockResolvedValue({
      batch_id: "b3",
      failed_events: [{ usage_event: { deduplication_id: "dedup-a" } }],
    });

    const result = await ingestBatch([entry("a"), entry("b")]);

    expect(result.failed.map((e) => e.id)).toEqual(["a"]);
  });

  it("retries the whole batch when failures are unattributable", async () => {
    mocks.batchIngest.mockResolvedValue({
      batch_id: "b4",
      failed_events: [{ reason: "internal_error" }],
    });

    const result = await ingestBatch([entry("a"), entry("b")]);

    expect(result.ingested).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
  });
});
