import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ appendUsageEvent: vi.fn() }));

vi.mock("./stream", () => ({ appendUsageEvent: mocks.appendUsageEvent }));

import { recordUsageEvent, usageIngestEnabled } from "./events";
import type { BufferedUsageEvent } from "./events";
import process from "node:process";

const event: BufferedUsageEvent = {
	deduplicationId: "0198c0a4-1f2e-7c3d-9b8a-1f2e3d4c5b6a",
	subscriptionId: "sub-1",
	usageTimestamp: Date.UTC(2026, 7, 29, 12),
	properties: {
		generation_id: "0198c0a4-1f2e-7c3d-9b8a-1f2e3d4c5b6a",
		model: "openai/gpt-4o-mini",
		input_tokens: 120,
		output_tokens: 340,
		credits_consumed: 1.5,
		usage_source: "credits",
		plan_id: "plan-pro",
	},
};

beforeEach(() => {
	mocks.appendUsageEvent.mockReset();
	process.env.CHARGEBEE_USAGE_INGEST_ENABLED = "true";
});

afterEach(() => {
	delete process.env.CHARGEBEE_USAGE_INGEST_ENABLED;
});

describe("usageIngestEnabled", () => {
	it("stays off unless explicitly switched on", () => {
		delete process.env.CHARGEBEE_USAGE_INGEST_ENABLED;
		expect(usageIngestEnabled()).toBe(false);

		process.env.CHARGEBEE_USAGE_INGEST_ENABLED = "1";
		expect(usageIngestEnabled()).toBe(false);

		process.env.CHARGEBEE_USAGE_INGEST_ENABLED = "true";
		expect(usageIngestEnabled()).toBe(true);
	});
});

describe("recordUsageEvent", () => {
	it("buffers the event as given", async () => {
		await recordUsageEvent(event);

		expect(mocks.appendUsageEvent).toHaveBeenCalledWith(event);
	});

	it("fits Chargebee's 36-character deduplication id limit", () => {
		expect(event.deduplicationId).toHaveLength(36);
	});

	it("writes nothing when usage tracking is unconfigured", async () => {
		delete process.env.CHARGEBEE_USAGE_INGEST_ENABLED;

		await recordUsageEvent(event);

		expect(mocks.appendUsageEvent).not.toHaveBeenCalled();
	});

	it("swallows a buffer failure so the generation still completes", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.appendUsageEvent.mockRejectedValue(new Error("redis down"));

		await expect(recordUsageEvent(event)).resolves.toBeUndefined();

		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});
