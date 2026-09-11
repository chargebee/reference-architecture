import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	batchIngest: vi.fn(),
	recordUsageBatch: vi.fn(),
	readUsageBatch: vi.fn(),
	reclaimStale: vi.fn(),
	ackUsageEvents: vi.fn(),
	deadLetterUsageEvents: vi.fn(),
	ensureConsumerGroup: vi.fn(),
	usageStreamDepth: vi.fn(),
}));

vi.mock("@/plugins/chargebee-plugin", () => ({
	chargebeeClient: { usageEvent: { batchIngest: mocks.batchIngest } },
}));

vi.mock("@/lib/events/emit", () => ({ emit: vi.fn() }));

vi.mock("./store", () => ({ recordUsageBatch: mocks.recordUsageBatch }));

vi.mock("./stream", () => ({
	readUsageBatch: mocks.readUsageBatch,
	reclaimStale: mocks.reclaimStale,
	ackUsageEvents: mocks.ackUsageEvents,
	deadLetterUsageEvents: mocks.deadLetterUsageEvents,
	ensureConsumerGroup: mocks.ensureConsumerGroup,
	usageStreamDepth: mocks.usageStreamDepth,
}));

import { flushUsage } from "./flush";
import { MAX_DELIVERIES, MAX_EVENT_AGE_MS } from "./ingest";
import type { UsageStreamEntry } from "./stream";

const CONSUMER = "worker-1";

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
			usageTimestamp: Date.now() - (overrides.ageMs ?? 0),
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
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.reclaimStale.mockResolvedValue([]);
	mocks.readUsageBatch.mockResolvedValue([]);
	mocks.usageStreamDepth.mockResolvedValue(0);
	mocks.recordUsageBatch.mockResolvedValue(undefined);
	mocks.batchIngest.mockResolvedValue({ batch_id: "b1", failed_events: [] });
});

describe("flushUsage", () => {
	it("does nothing when the buffer is empty", async () => {
		const result = await flushUsage(CONSUMER);

		expect(mocks.batchIngest).not.toHaveBeenCalled();
		expect(result.ingested).toBe(0);
	});

	it("archives the batch before it reaches Chargebee", async () => {
		mocks.readUsageBatch.mockResolvedValue([entry("a"), entry("b")]);

		await flushUsage(CONSUMER);

		expect(mocks.recordUsageBatch).toHaveBeenCalledWith([
			expect.objectContaining({ deduplicationId: "dedup-a" }),
			expect.objectContaining({ deduplicationId: "dedup-b" }),
		]);
		expect(mocks.recordUsageBatch.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.batchIngest.mock.invocationCallOrder[0],
		);
	});

	it("archives events Chargebee refuses on age", async () => {
		mocks.readUsageBatch.mockResolvedValue([
			entry("old", { ageMs: MAX_EVENT_AGE_MS + 1_000 }),
		]);

		await flushUsage(CONSUMER);

		expect(mocks.recordUsageBatch).toHaveBeenCalledWith([
			expect.objectContaining({ deduplicationId: "dedup-old" }),
		]);
		expect(mocks.batchIngest).not.toHaveBeenCalled();
	});

	it("abandons the pass when the archive write fails", async () => {
		mocks.readUsageBatch.mockResolvedValue([entry("a")]);
		mocks.recordUsageBatch.mockRejectedValue(new Error("connection refused"));

		await expect(flushUsage(CONSUMER)).rejects.toThrow("connection refused");

		expect(mocks.batchIngest).not.toHaveBeenCalled();
		expect(mocks.ackUsageEvents).not.toHaveBeenCalled();
		expect(mocks.deadLetterUsageEvents).not.toHaveBeenCalled();
	});

	it("finishes a dead worker's entries before reading new ones", async () => {
		mocks.reclaimStale.mockResolvedValue([entry("stale")]);
		mocks.readUsageBatch.mockResolvedValue([entry("fresh")]);

		await flushUsage(CONSUMER);

		expect(mocks.readUsageBatch).not.toHaveBeenCalled();
		expect(mocks.ackUsageEvents).toHaveBeenCalledWith(["stale"]);
	});

	it("acknowledges an ingested batch", async () => {
		mocks.readUsageBatch.mockResolvedValue([entry("a"), entry("b")]);

		const result = await flushUsage(CONSUMER);

		expect(mocks.ackUsageEvents).toHaveBeenCalledWith(["a", "b"]);
		expect(result.ingested).toBe(2);
	});

	it("leaves rejected entries pending so they are reclaimed", async () => {
		mocks.readUsageBatch.mockResolvedValue([entry("a"), entry("b")]);
		mocks.batchIngest.mockResolvedValue({
			batch_id: "b1",
			failed_events: [{ deduplication_id: "dedup-b" }],
		});

		const result = await flushUsage(CONSUMER);

		expect(mocks.ackUsageEvents).toHaveBeenCalledWith(["a"]);
		expect(result.retrying).toBe(1);
	});

	it("parks events past the backdating window without ingesting them", async () => {
		mocks.readUsageBatch.mockResolvedValue([
			entry("old", { ageMs: MAX_EVENT_AGE_MS + 1_000 }),
		]);

		const result = await flushUsage(CONSUMER);

		expect(mocks.batchIngest).not.toHaveBeenCalled();
		expect(mocks.deadLetterUsageEvents).toHaveBeenCalledWith(
			[expect.objectContaining({ id: "old" })],
			"backdating_window_exceeded",
		);
		expect(result.expired).toBe(1);
	});

	it("parks entries that have exhausted their attempts", async () => {
		mocks.reclaimStale.mockResolvedValue([
			entry("spent", { deliveries: MAX_DELIVERIES + 1 }),
			entry("ok"),
		]);

		const result = await flushUsage(CONSUMER);

		expect(mocks.deadLetterUsageEvents).toHaveBeenCalledWith(
			[expect.objectContaining({ id: "spent" })],
			`exceeded_${MAX_DELIVERIES}_attempts`,
		);
		expect(result.exhausted).toBe(1);
		expect(result.ingested).toBe(1);
	});

	it("reports remaining depth so the loop keeps draining", async () => {
		mocks.readUsageBatch.mockResolvedValue([entry("a")]);
		mocks.usageStreamDepth.mockResolvedValue(1_200);

		const result = await flushUsage(CONSUMER);

		expect(result.depth).toBe(1_200);
	});
});
