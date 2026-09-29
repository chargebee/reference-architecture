import type { WebhookEvent } from "chargebee";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	assertDependencies: vi.fn(async () => undefined),
	assertProcessed: vi.fn(async () => undefined),
	commitVersions: vi.fn(async () => undefined),
	emit: vi.fn(async () => undefined),
	isEventStale: vi.fn(async () => false),
	pluginProcess: vi.fn(async () => undefined),
	processAlertWebhook: vi.fn(async () => false),
	processEntitlementWebhook: vi.fn(async () => false),
}));

vi.mock("@/lib/alerts/sync", () => ({
	processAlertWebhook: mocks.processAlertWebhook,
}));
vi.mock("@/lib/entitlements/sync", () => ({
	processEntitlementWebhook: mocks.processEntitlementWebhook,
}));
vi.mock("@/lib/events/emit", () => ({
	emit: mocks.emit,
}));
vi.mock("@/lib/webhooks/webhook-guards", () => ({
	assertDependencies: mocks.assertDependencies,
	assertProcessed: mocks.assertProcessed,
	commitVersions: mocks.commitVersions,
	isEventStale: mocks.isEventStale,
}));

import {
	ChargebeeEventOutcome,
	runChargebeeEventPipeline,
} from "./chargebee-event-pipeline";

function event(eventType = "subscription_changed"): WebhookEvent {
	return {
		id: "event-1",
		event_type: eventType,
		occurred_at: 123,
		content: {},
	} as WebhookEvent;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.assertDependencies.mockResolvedValue(undefined);
	mocks.assertProcessed.mockResolvedValue(undefined);
	mocks.commitVersions.mockResolvedValue(undefined);
	mocks.emit.mockResolvedValue(undefined);
	mocks.isEventStale.mockResolvedValue(false);
	mocks.pluginProcess.mockResolvedValue(undefined);
	mocks.processAlertWebhook.mockResolvedValue(false);
	mocks.processEntitlementWebhook.mockResolvedValue(false);
});

describe("standard Chargebee event pipeline", () => {
	it("runs the standard pipeline", async () => {
		const webhook = event();

		const outcome = await runChargebeeEventPipeline(
			webhook,
			{ process: mocks.pluginProcess },
			{ sqsMessageId: "message-1" },
		);

		expect(outcome).toBe(ChargebeeEventOutcome.ProcessedStandard);
		expect(mocks.assertDependencies).toHaveBeenCalledWith(webhook);
		expect(mocks.pluginProcess).toHaveBeenCalledWith(webhook);
		expect(mocks.assertProcessed).toHaveBeenCalledWith(webhook);
		expect(mocks.processEntitlementWebhook).toHaveBeenCalledWith(webhook);
		expect(mocks.commitVersions).toHaveBeenCalledWith(webhook);
		expect(mocks.emit).toHaveBeenCalledWith(
			"chargebee.webhook_processed",
			expect.objectContaining({ sqs_message_id: "message-1" }),
			{ source: "worker", trace_id: "event-1" },
		);
	});
});

describe("alternate Chargebee event outcomes", () => {
	it("skips stale events before processing", async () => {
		mocks.isEventStale.mockResolvedValueOnce(true);

		const outcome = await runChargebeeEventPipeline(event(), {
			process: mocks.pluginProcess,
		});

		expect(outcome).toBe(ChargebeeEventOutcome.Stale);
		expect(mocks.processAlertWebhook).not.toHaveBeenCalled();
		expect(mocks.pluginProcess).not.toHaveBeenCalled();
		expect(mocks.commitVersions).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledWith(
			"chargebee.webhook_skipped_stale",
			expect.objectContaining({ webhook_event_id: "event-1" }),
			{ source: "worker", trace_id: "event-1" },
		);
	});

	it("commits alert events without running the standard path", async () => {
		mocks.processAlertWebhook.mockResolvedValueOnce(true);
		const webhook = event("alert_status_changed");

		const outcome = await runChargebeeEventPipeline(webhook, {
			process: mocks.pluginProcess,
		});

		expect(outcome).toBe(ChargebeeEventOutcome.ProcessedAlert);
		expect(mocks.assertDependencies).not.toHaveBeenCalled();
		expect(mocks.pluginProcess).not.toHaveBeenCalled();
		expect(mocks.assertProcessed).not.toHaveBeenCalled();
		expect(mocks.processEntitlementWebhook).not.toHaveBeenCalled();
		expect(mocks.commitVersions).toHaveBeenCalledWith(webhook);
		expect(mocks.emit).toHaveBeenCalledWith(
			"chargebee.webhook_processed",
			expect.objectContaining({ webhook_event_id: "event-1" }),
			{ source: "worker", trace_id: "event-1" },
		);
	});
});
