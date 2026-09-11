/**
 * Exercises the real Redis Streams mechanics — consumer group, PEL, reclaim —
 * which a mocked client cannot meaningfully verify.
 *
 * Gated behind RUN_REDIS_TESTS=1 because it writes to and clears the usage
 * stream keys. Point it at a local Redis, never a shared one.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getRedis } from "@/lib/redis";

import type { BufferedUsageEvent } from "./events";
import {
	USAGE_DEAD_STREAM_KEY,
	USAGE_STREAM_KEY,
	ackUsageEvents,
	appendUsageEvent,
	deadLetterUsageEvents,
	ensureConsumerGroup,
	readUsageBatch,
	reclaimStale,
	usageStreamDepth,
} from "./stream";
import process from "node:process";

const redisTests =
	process.env.RUN_REDIS_TESTS === "1" ? describe : describe.skip;

function event(id: string): BufferedUsageEvent {
	return {
		deduplicationId: `dedup-${id}`,
		subscriptionId: "sub-1",
		usageTimestamp: Date.now(),
		properties: {
			generation_id: `gen-${id}`,
			model: "openai/gpt-4o-mini",
			input_tokens: 10,
			output_tokens: 20,
			credits_consumed: 0,
			usage_source: "plan_quota",
			plan_id: "plan-pro",
		},
	};
}

redisTests("usage stream", () => {
	beforeEach(async () => {
		await getRedis().del(USAGE_STREAM_KEY, USAGE_DEAD_STREAM_KEY);
		await ensureConsumerGroup();
	});

	afterAll(async () => {
		const redis = getRedis();
		await redis.del(USAGE_STREAM_KEY, USAGE_DEAD_STREAM_KEY);
		await redis.quit();
	});

	it("creates the group idempotently", async () => {
		await expect(ensureConsumerGroup()).resolves.toBeUndefined();
	});

	it("round-trips an event through append, read and ack", async () => {
		await appendUsageEvent(event("a"));

		const entries = await readUsageBatch("worker-1");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.event.deduplicationId).toBe("dedup-a");
		expect(entries[0]?.deliveries).toBe(1);

		await ackUsageEvents(entries.map((entry) => entry.id));
		expect(await usageStreamDepth()).toBe(0);
	});

	it("does not redeliver to a second consumer while pending", async () => {
		await appendUsageEvent(event("a"));
		await readUsageBatch("worker-1");

		expect(await readUsageBatch("worker-2")).toHaveLength(0);
	});

	it("lets another worker reclaim what a dead one held", async () => {
		await appendUsageEvent(event("a"));
		await readUsageBatch("worker-1");

		const reclaimed = await reclaimStale("worker-2", 0);

		expect(reclaimed.map((entry) => entry.event.deduplicationId)).toEqual([
			"dedup-a",
		]);
		// The count from before this claim, so it climbs on every failed pass.
		expect(reclaimed[0]?.deliveries).toBe(1);
		expect((await reclaimStale("worker-3", 0))[0]?.deliveries).toBe(2);
	});

	it("reclaims nothing when the group is fully acknowledged", async () => {
		await appendUsageEvent(event("a"));
		const entries = await readUsageBatch("worker-1");
		await ackUsageEvents(entries.map((entry) => entry.id));

		expect(await reclaimStale("worker-2", 0)).toHaveLength(0);
	});

	it("parks dead-lettered events and clears them from the buffer", async () => {
		await appendUsageEvent(event("a"));
		const entries = await readUsageBatch("worker-1");

		await deadLetterUsageEvents(entries, "backdating_window_exceeded");

		expect(await usageStreamDepth()).toBe(0);
		expect(await getRedis().xlen(USAGE_DEAD_STREAM_KEY)).toBe(1);
		expect(await reclaimStale("worker-2", 0)).toHaveLength(0);
	});

	it("caps a read at the requested batch size", async () => {
		for (const id of ["a", "b", "c"]) await appendUsageEvent(event(id));

		expect(await readUsageBatch("worker-1", 2)).toHaveLength(2);
	});
});
