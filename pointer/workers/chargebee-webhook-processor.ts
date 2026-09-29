import { SQSClient, type Message } from "@aws-sdk/client-sqs";
import {
	createChargebeeWebhookProcessor,
	type ChargebeeWebhookProcessorSource,
} from "@chargebee/better-auth";
import type { WebhookEvent } from "chargebee";

import { auth } from "@/lib/auth";
import type { EntitlementSyncJob } from "@/lib/entitlements/queue";
import { runEntitlementSyncJob } from "@/lib/entitlements/sync";
import { emit } from "@/lib/events/emit";
import {
	type ChargebeePluginProcessor,
	runChargebeeEventPipeline,
} from "@/lib/webhooks/chargebee-event-pipeline";
import { parseQueueMessage } from "@/lib/webhooks/parse-queue-message";
import { toRetryableError } from "@/lib/webhooks/retryable";
import {
	backoffSeconds,
	createSqsWebhookTransport,
	type SqsWebhookTransport,
} from "@/lib/webhooks/sqs-transport";
import { PoisonWebhookError } from "@/lib/webhooks/webhook-errors";
import { chargebeePluginOptions } from "@/plugins/chargebee-plugin";

export { backoffSeconds };

export interface ChargebeeWebhookMessageProcessorOptions {
	queueUrl: string;
	dlqUrl: string;
	sqs?: SQSClient;
}

export type ChargebeeWebhookMessageProcessor = (
	message: Message,
) => Promise<void>;

interface MessageContext {
	message: Message;
	receiveCount: number;
	transport: SqsWebhookTransport;
}

async function handleSyncJob(
	job: EntitlementSyncJob,
	context: MessageContext,
): Promise<void> {
	console.log("[chargebee-worker]", {
		messageId: context.message.MessageId,
		jobId: job.id,
		job: job.job,
		reason: job.reason,
		subscriptionId: job.chargebeeSubscriptionId,
		receiveCount: context.receiveCount,
	});

	try {
		await runEntitlementSyncJob(job);
	} catch (err) {
		await context.transport.applyBackoff(context.message, context.receiveCount);
		throw toRetryableError(err);
	}
}

async function scheduleRetry(
	event: WebhookEvent,
	err: unknown,
	context: MessageContext,
): Promise<never> {
	await context.transport.applyBackoff(context.message, context.receiveCount);
	await emit(
		"chargebee.webhook_retry_scheduled",
		{
			webhook_event_type: event.event_type,
			webhook_event_id: event.id,
			occurred_at: event.occurred_at,
			receive_count: context.receiveCount,
			backoff_seconds: backoffSeconds(context.receiveCount),
			reason: err instanceof Error ? err.message : String(err),
		},
		{ source: "worker", trace_id: event.id },
	);

	throw toRetryableError(err);
}

async function handleChargebeeEvent(
	event: WebhookEvent,
	context: MessageContext,
	processorPromise: Promise<ChargebeePluginProcessor>,
): Promise<void> {
	console.log("[chargebee-worker]", {
		messageId: context.message.MessageId,
		eventId: event.id,
		eventType: event.event_type,
		occurredAt: event.occurred_at,
		receiveCount: context.receiveCount,
	});

	try {
		await runChargebeeEventPipeline(event, await processorPromise, {
			sqsMessageId: context.message.MessageId,
		});
	} catch (err) {
		if (err instanceof PoisonWebhookError) {
			await context.transport.routePoison(context.message, event, err);
			return;
		}

		await scheduleRetry(event, err, context);
	}
}

export function createChargebeeWebhookMessageProcessor({
	queueUrl,
	dlqUrl,
	sqs = new SQSClient(),
}: ChargebeeWebhookMessageProcessorOptions): ChargebeeWebhookMessageProcessor {
	const transport = createSqsWebhookTransport({ queueUrl, dlqUrl, sqs });

	const processorPromise = auth.$context.then((ctx) =>
		createChargebeeWebhookProcessor(chargebeePluginOptions, {
			context: { adapter: ctx.adapter, logger: ctx.logger },
		} as unknown as ChargebeeWebhookProcessorSource),
	);

	return async function processMessage(message: Message): Promise<void> {
		const receiveCount = Number(
			message.Attributes?.ApproximateReceiveCount ?? "1",
		);
		const context = { message, receiveCount, transport };

		const parsed = parseQueueMessage(message.Body ?? "{}");
		if (parsed.kind === "poison") {
			await transport.routePoison(message, undefined, parsed.error);
			return;
		}

		if (parsed.kind === "entitlement_sync") {
			await handleSyncJob(parsed.job, context);
			return;
		}

		await handleChargebeeEvent(parsed.event, context, processorPromise);
	};
}
