import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import type { WebhookHandler } from "chargebee";

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

/**
 * Registers a Chargebee webhook listener that forwards every incoming event
 * payload to an SQS queue. Downstream consumers (workers, lambdas, etc.) do
 * the actual fan-out / processing — keeping the webhook endpoint fast and
 * decoupled from business logic.
 */
export function registerChargebeeWebhookForwarder(handler: WebhookHandler) {
  // `unhandled_event` fires for any event type that has no specific listener
  // registered. Since we want to forward _everything_, registering only this
  // listener captures the full Chargebee event stream.
  handler.on("unhandled_event", async ({ event }) => {
    const client = getSqsClient();
    const queueUrl = process.env.CHARGEBEE_WEBHOOK_SQS_QUEUE_URL!;

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event),
        // Use the event id for FIFO dedupe; ignored on standard queues.
        MessageDeduplicationId: queueUrl.endsWith(".fifo")
          ? (event as { id?: string }).id
          : undefined,
        MessageGroupId: queueUrl.endsWith(".fifo")
          ? "chargebee-webhooks"
          : undefined,
      }),
    );
  });

  handler.on("error", (error) => {
    console.error("[chargebee-webhook] handler error:", error);
  });
}
