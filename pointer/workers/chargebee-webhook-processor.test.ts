import {
	ChangeMessageVisibilityCommand,
	SendMessageCommand,
	type Message,
	type SQSClient,
} from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RetryableWebhookError } from "@/lib/webhooks/webhook-errors";

const mocks = vi.hoisted(() => ({
	assertDependencies: vi.fn(async () => undefined),
	assertProcessed: vi.fn(async () => undefined),
	commitVersions: vi.fn(async () => undefined),
	emit: vi.fn(async () => undefined),
	isEventStale: vi.fn(async () => false),
	pluginProcess: vi.fn(async () => undefined),
	processEntitlementWebhook: vi.fn(async () => false),
	runEntitlementSyncJob: vi.fn(async () => undefined),
	sqsSend: vi.fn(async (command: unknown) => {
		void command;
		return {};
	}),
}));

vi.mock("@chargebee/better-auth", () => ({
	createChargebeeWebhookProcessor: () => ({
		process: mocks.pluginProcess,
	}),
}));
vi.mock("@/lib/auth", () => ({
	auth: {
		$context: Promise.resolve({ adapter: {}, logger: {} }),
	},
}));
vi.mock("@/lib/entitlements/sync", () => ({
	processEntitlementWebhook: mocks.processEntitlementWebhook,
	runEntitlementSyncJob: mocks.runEntitlementSyncJob,
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
vi.mock("@/plugins/chargebee-plugin", () => ({
	chargebeePluginOptions: {},
}));

import {
	backoffSeconds,
	createChargebeeWebhookMessageProcessor,
} from "./chargebee-webhook-processor";

function message(body: string, receiveCount = "1"): Message {
	return {
		MessageId: "message-1",
		ReceiptHandle: "receipt-1",
		Body: body,
		Attributes: { ApproximateReceiveCount: receiveCount },
	};
}

function createProcessor() {
	return createChargebeeWebhookMessageProcessor({
		queueUrl: "https://sqs.example/main",
		dlqUrl: "https://sqs.example/dlq",
		sqs: { send: mocks.sqsSend } as unknown as SQSClient,
	});
}

describe("Chargebee webhook message processor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.assertDependencies.mockResolvedValue(undefined);
		mocks.assertProcessed.mockResolvedValue(undefined);
		mocks.commitVersions.mockResolvedValue(undefined);
		mocks.emit.mockResolvedValue(undefined);
		mocks.isEventStale.mockResolvedValue(false);
		mocks.pluginProcess.mockResolvedValue(undefined);
		mocks.processEntitlementWebhook.mockResolvedValue(false);
		mocks.runEntitlementSyncJob.mockResolvedValue(undefined);
		mocks.sqsSend.mockResolvedValue({});
	});

	it("runs the complete webhook correctness pipeline", async () => {
		const processMessage = createProcessor();

		await processMessage(
			message(
				JSON.stringify({
					id: "event-1",
					event_type: "subscription_changed",
					occurred_at: 123,
					content: {},
				}),
			),
		);

		expect(mocks.assertDependencies).toHaveBeenCalledTimes(1);
		expect(mocks.pluginProcess).toHaveBeenCalledTimes(1);
		expect(mocks.assertProcessed).toHaveBeenCalledTimes(1);
		expect(mocks.processEntitlementWebhook).toHaveBeenCalledTimes(1);
		expect(mocks.commitVersions).toHaveBeenCalledTimes(1);
	});

	it("routes malformed bodies to the DLQ without retrying", async () => {
		const processMessage = createProcessor();

		await expect(processMessage(message("{invalid"))).resolves.toBeUndefined();

		expect(mocks.sqsSend).toHaveBeenCalledTimes(1);
		const command = mocks.sqsSend.mock.calls[0]?.[0] as SendMessageCommand;
		expect(command).toBeInstanceOf(SendMessageCommand);
		expect(command.input).toEqual({
			QueueUrl: "https://sqs.example/dlq",
			MessageBody: "{invalid",
		});
	});

	it("backs off and rethrows retryable failures", async () => {
		const processMessage = createProcessor();
		mocks.assertDependencies.mockRejectedValueOnce(
			new RetryableWebhookError("dependency not ready"),
		);

		await expect(
			processMessage(
				message(
					JSON.stringify({
						id: "event-retry",
						event_type: "subscription_created",
						content: {},
					}),
					"4",
				),
			),
		).rejects.toThrow("dependency not ready");

		const command = mocks.sqsSend.mock
			.calls[0]?.[0] as ChangeMessageVisibilityCommand;
		expect(command).toBeInstanceOf(ChangeMessageVisibilityCommand);
		expect(command.input).toEqual({
			QueueUrl: "https://sqs.example/main",
			ReceiptHandle: "receipt-1",
			VisibilityTimeout: 240,
		});
	});

	it("processes entitlement jobs without entering the webhook pipeline", async () => {
		const processMessage = createProcessor();
		const job = {
			job: "entitlements.sync",
			id: "job-1",
			requestedAt: new Date().toISOString(),
			reason: "manual",
			chargebeeSubscriptionId: "subscription-1",
		};

		await processMessage(message(JSON.stringify(job)));

		expect(mocks.runEntitlementSyncJob).toHaveBeenCalledWith(job);
		expect(mocks.isEventStale).not.toHaveBeenCalled();
		expect(mocks.pluginProcess).not.toHaveBeenCalled();
	});
});

describe("backoffSeconds", () => {
	it("grows exponentially and caps at fifteen minutes", () => {
		expect(backoffSeconds(1)).toBe(30);
		expect(backoffSeconds(4)).toBe(240);
		expect(backoffSeconds(99)).toBe(900);
	});
});
