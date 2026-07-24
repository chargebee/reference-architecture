import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { ChargebeeWebhookEventBus } from "@chargebee/better-auth";
import type { WebhookEvent } from "chargebee";

import { emit } from "@/lib/events/emit";
import { versionedResources } from "@/lib/webhooks/webhook-guards";

declare global {
  // Cache the SQS client across HMR reloads so we don't leak sockets in dev.
  var __sqsClient: SQSClient | undefined;
}

function getSqsClient(): SQSClient {
  if (globalThis.__sqsClient) return globalThis.__sqsClient;

  const client = new SQSClient();

  if (process.env.NODE_ENV !== "production") {
    globalThis.__sqsClient = client;
  }
  return client;
}

function getQueueUrl(): string {
  const queueUrl = process.env.CHARGEBEE_WEBHOOK_SQS_QUEUE_URL;
  if (!queueUrl) {
    throw new Error(
      "CHARGEBEE_WEBHOOK_SQS_QUEUE_URL environment variable is required",
    );
  }
  return queueUrl;
}

async function publishChargebeeWebhookEvent(event: WebhookEvent): Promise<void> {
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
  const queueUrl = getQueueUrl();

  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(event),
      // Use the event id for FIFO dedupe; ignored on standard queues.
      MessageDeduplicationId: queueUrl.endsWith(".fifo")
        ? event.id
        : undefined,
      MessageGroupId: queueUrl.endsWith(".fifo") ? "chargebee-webhooks" : undefined,
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
