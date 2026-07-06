import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import type { ChargebeeWebhookEventBus } from "@chargebee/better-auth";
import type { WebhookEvent } from "chargebee";

declare global {
  // Cache the SQS client across HMR reloads so we don't leak sockets in dev.
  var __sqsClient: SQSClient | undefined;
}

function getSqsClient(): SQSClient {
  if (globalThis.__sqsClient) return globalThis.__sqsClient;

  const region = process.env.AWS_REGION ?? "us-east-1";
  const profile = process.env.AWS_PROFILE;

  const client = new SQSClient({
    region,
    // Only pin a profile-based credential provider when AWS_PROFILE is set.
    // Otherwise fall back to the default chain (env vars, IAM role, etc.)
    // so this works unchanged in ECS/EC2/Lambda.
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });

  if (process.env.NODE_ENV !== "production") {
    globalThis.__sqsClient = client;
  }
  return client;
}

function getQueueUrl(): string {
  const queueUrl =
    process.env.SQS_QUEUE_URL ?? process.env.CHARGEBEE_WEBHOOK_SQS_QUEUE_URL;
  if (!queueUrl) {
    throw new Error(
      "SQS_QUEUE_URL (or CHARGEBEE_WEBHOOK_SQS_QUEUE_URL) environment variable is required",
    );
  }
  return queueUrl;
}

async function publishChargebeeWebhookEvent(event: WebhookEvent): Promise<void> {
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
}

/**
 * Event bus passed to the Chargebee plugin's `webhookEventBus` option.
 *
 * The plugin validates and parses each incoming webhook, then calls
 * `publish` instead of running DB-sync hooks inline. The worker consumes
 * from the same queue and runs those hooks via `createChargebeeWebhookProcessor`.
 */
export const chargebeeWebhookEventBus: ChargebeeWebhookEventBus = {
  publish: publishChargebeeWebhookEvent,
};
