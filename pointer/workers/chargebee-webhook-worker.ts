/**
 * Chargebee webhook worker.
 *
 * Long-polls the Chargebee webhook SQS queue and processes each message.
 * Currently a scaffold: deserialize -> structured log -> ack (delete from
 * queue). Drop typed per-event handlers (e.g. `subscription_created`,
 * `customer_created`) into `handleMessage` when business logic lands.
 *
 * # Horizontal scaling
 *
 *   Chargebee --(webhook POST)--> Next.js --(SendMessage)--> SQS main queue
 *                                                                |
 *                                          +---------------------+---------------------+
 *                                          v                     v                     v
 *                                   worker proc 1         worker proc 2         worker proc N
 *                                          \                     |                     /
 *                                           +---- after 5 failed receives -----------> DLQ
 *
 * Adding more workers = run more processes / ECS tasks. SQS itself fans
 * messages out across whatever consumers are connected; visibility timeout
 * (see infra/sqs.tf) prevents two workers from processing the same message,
 * and the redrive policy (maxReceiveCount=5) routes poison messages to the
 * DLQ. No leader election or coordinator required.
 */

import { SQSClient } from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import { Consumer } from "sqs-consumer";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const queueUrl = requireEnv("CHARGEBEE_WEBHOOK_SQS_QUEUE_URL");
const region = process.env.AWS_REGION ?? "us-east-1";
const profile = process.env.AWS_PROFILE;

const sqs = new SQSClient({
  region,
  // Only pin a profile-based credential provider when AWS_PROFILE is set;
  // otherwise fall back to the default chain (env vars / IAM task role).
  ...(profile ? { credentials: fromIni({ profile }) } : {}),
});

const consumer = Consumer.create({
  queueUrl,
  sqs,
  batchSize: 10,
  waitTimeSeconds: 20,
  visibilityTimeout: 30,
  heartbeatInterval: 10,
  handleMessage: async (message) => {
    const event = JSON.parse(message.Body ?? "{}") as {
      id?: string;
      event_type?: string;
      occurred_at?: number;
    };
    console.log("[chargebee-worker]", {
      messageId: message.MessageId,
      eventId: event.id,
      eventType: event.event_type,
      occurredAt: event.occurred_at,
    });
    // Returning resolves => sqs-consumer deletes the message (ack).
    // Throwing => message stays, becomes visible again after visibilityTimeout,
    // and after maxReceiveCount=5 attempts is routed to the DLQ.
    return message;
  },
});

consumer.on("error", (err) => {
  console.error("[chargebee-worker] error", err);
});
consumer.on("processing_error", (err, msg) => {
  console.error("[chargebee-worker] processing_error", {
    messageId: msg?.MessageId,
    err,
  });
});
consumer.on("timeout_error", (err) => {
  console.error("[chargebee-worker] timeout_error", err);
});

const shutdown = (signal: string) => {
  console.log(`[chargebee-worker] ${signal} received, draining...`);
  // abort: false => let in-flight handlers finish before stopping.
  consumer.stop({ abort: false });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

consumer.start();
console.log(`[chargebee-worker] polling ${queueUrl} (region=${region})`);
