import { SQSClient } from "@aws-sdk/client-sqs";

declare global {
  // Cache the SQS client across HMR reloads so we don't leak sockets in dev.
  var __sqsClient: SQSClient | undefined;
}

export function getSqsClient(): SQSClient {
  if (globalThis.__sqsClient) return globalThis.__sqsClient;

  const client = new SQSClient();

  if (process.env.NODE_ENV !== "production") {
    globalThis.__sqsClient = client;
  }
  return client;
}

/**
 * The Chargebee webhook queue also carries entitlement refresh jobs created
 * after subscription provisioning (see `lib/entitlements/queue.ts`), so the
 * worker only needs one consumer loop and one DLQ.
 */
export function getWebhookQueueUrl(): string {
  const queueUrl = process.env.CHARGEBEE_WEBHOOK_SQS_QUEUE_URL;
  if (!queueUrl) {
    throw new Error(
      "CHARGEBEE_WEBHOOK_SQS_QUEUE_URL environment variable is required",
    );
  }
  return queueUrl;
}

export function isFifoQueue(queueUrl: string): boolean {
  return queueUrl.endsWith(".fifo");
}
