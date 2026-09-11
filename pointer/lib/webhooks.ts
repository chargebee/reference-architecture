import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { ChargebeeWebhookEventBus } from "@chargebee/better-auth";
import type { WebhookEvent } from "chargebee";

import { emit } from "@/lib/events/emit";
import { getSqsClient, getWebhookQueueUrl, isFifoQueue } from "@/lib/queue";
import { versionedResources } from "@/lib/webhooks/webhook-guards";

async function publishChargebeeWebhookEvent(
	event: WebhookEvent,
): Promise<void> {
	// Tap every validated webhook at publish time for the live /flow visualization.
	// This replaces the plugin's webhookHandler option, which is not used when
	// webhookEventBus is configured.
	await emit(
		"chargebee.webhook_received",
		{
			webhook_event_type: event.event_type,
			webhook_event_id: event.id,
			occurred_at: event.occurred_at,
			content: event.content,
			// Surface per-resource versions so the /flow view can visualize
			// out-of-order delivery. The worker uses these for staleness checks.
			resource_versions: versionedResources(event).map((r) => ({
				resource_type: r.resourceType,
				resource_id: r.resourceId,
				resource_version: r.resourceVersion,
			})),
		},
		{ trace_id: event.id },
	);

	const client = getSqsClient();
	const queueUrl = getWebhookQueueUrl();
	const fifo = isFifoQueue(queueUrl);

	await client.send(
		new SendMessageCommand({
			QueueUrl: queueUrl,
			MessageBody: JSON.stringify(event),
			// Use the event id for FIFO dedupe; ignored on standard queues.
			MessageDeduplicationId: fifo ? event.id : undefined,
			MessageGroupId: fifo ? "chargebee-webhooks" : undefined,
		}),
	);

	await emit(
		"chargebee.webhook_queued",
		{
			webhook_event_type: event.event_type,
			webhook_event_id: event.id,
			occurred_at: event.occurred_at,
		},
		{ source: "app", trace_id: event.id },
	);
}

/**
 * Event bus passed to the Chargebee plugin's `webhookEventBus` option.
 *
 * The plugin validates and parses each incoming webhook, then calls
 * `publish` instead of running DB-sync hooks inline. Each publish emits
 * `chargebee.webhook_received` and, after a successful SQS send,
 * `chargebee.webhook_queued` for the live /flow visualization. The worker
 * consumes from the same queue, runs DB-sync hooks via
 * `createChargebeeWebhookProcessor`, and emits `chargebee.webhook_processed`.
 */
export const chargebeeWebhookEventBus: ChargebeeWebhookEventBus = {
	publish: publishChargebeeWebhookEvent,
};
