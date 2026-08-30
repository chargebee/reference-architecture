import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usage/events", () => ({ usageIngestEnabled: vi.fn() }));
vi.mock("@/lib/usage/flush", () => ({ flushUsage: vi.fn() }));

import type { FlushResult } from "@/lib/usage/flush";

import { nextDelay } from "./usage-flush-loop";

const IDLE = 60_000;
const BACKLOG = 1_000;

function result(overrides: Partial<FlushResult> = {}): FlushResult {
  return { ingested: 0, retrying: 0, expired: 0, exhausted: 0, depth: 0, ...overrides };
}

describe("nextDelay", () => {
  it("waits the idle interval on an empty buffer", () => {
    expect(nextDelay(result(), IDLE)).toBe(IDLE);
  });

  it("drains a backlog without waiting a full interval", () => {
    expect(nextDelay(result({ ingested: 500, depth: 2_000 }), IDLE)).toBe(BACKLOG);
  });

  it("waits the idle interval once the buffer is clear", () => {
    expect(nextDelay(result({ ingested: 12, depth: 0 }), IDLE)).toBe(IDLE);
  });

  it("backs off instead of hammering a failing Chargebee", () => {
    // Depth stays high because every entry was rejected and left pending.
    expect(nextDelay(result({ retrying: 500, depth: 5_000 }), IDLE)).toBe(IDLE);
  });

  it("treats parked events as progress, since they clear the buffer", () => {
    expect(nextDelay(result({ expired: 30, depth: 900 }), IDLE)).toBe(BACKLOG);
    expect(nextDelay(result({ exhausted: 4, depth: 900 }), IDLE)).toBe(BACKLOG);
  });
});
