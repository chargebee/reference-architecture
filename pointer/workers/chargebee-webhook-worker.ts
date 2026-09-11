/**
 * Chargebee webhook worker.
 *
 * Long-polls the Chargebee webhook SQS queue and processes each message with
 * the Better Auth Chargebee plugin's DB-sync hooks via
 * `createChargebeeWebhookProcessor`, wrapped in a correctness pipeline that
 * the plugin itself can't provide.
 *
 * # Per-message pipeline
 *
 *   parse ─▶ stale/duplicate guard ─▶ dependency pre-check ─▶ process
 *         ─▶ verify-after-process ─▶ commit versions ─▶ ack
 *
 * Idempotency needs no inbox: SQS is at-least-once, but our hooks are
 * idempotent and the `resource_version` guard turns a redelivered/stale event
 * into a skip. See docs/plans/5-webhook-correctness.md.
 *
 * # App-originated jobs
 *
 * The same queue carries entitlement sync jobs enqueued after a subscription
 * webhook creates its local mirror. They are discriminated by `job` and bypass
 * the webhook pipeline — there is no Chargebee event to order or verify — but
 * reuse this loop's retry backoff and DLQ.
 *
 * # Error handling
 *
 *   - Retryable/dependency/transient errors get increasing visibility backoff.
 *   - Poison messages go directly to the DLQ and are acknowledged.
 *   - Unknown errors -> treated as retryable (safer default).
 *
 * # Horizontal scaling
 *
 *   Adding more workers = run more processes / ECS tasks. SQS fans messages out
 *   across consumers; the visibility timeout prevents two workers from
 *   processing the same message. No leader election required.
 */

import { SQSClient } from "@aws-sdk/client-sqs";
import { Consumer } from "sqs-consumer";

import { createChargebeeWebhookMessageProcessor } from "./chargebee-webhook-processor";
import { startUsageFlushIfEnabled } from "./usage-flush-loop";
import process from "node:process";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} environment variable is required`);
	}
	return value;
}

const queueUrl = requireEnv("CHARGEBEE_WEBHOOK_SQS_QUEUE_URL");
const dlqUrl = requireEnv("CHARGEBEE_WEBHOOK_DLQ_URL");

const sqs = new SQSClient();
const processMessage = createChargebeeWebhookMessageProcessor({
	queueUrl,
	dlqUrl,
	sqs,
});

const consumer = Consumer.create({
	queueUrl,
	sqs,
	batchSize: 10,
	waitTimeSeconds: 20,
	visibilityTimeout: 30,
	heartbeatInterval: 10,
	// Expose the delivery count so we can drive an increasing retry backoff.
	messageSystemAttributeNames: ["ApproximateReceiveCount"],
	handleMessage: async (message) => {
		await processMessage(message);
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

// Usage batching rides this process rather than its own service: the flush is
// a periodic drain of a Redis stream, and this is already a long-running task
// in the VPC with a Redis connection. See workers/usage-flush-loop.ts.
const usageFlush = startUsageFlushIfEnabled();

const shutdown = (signal: string) => {
	console.log(`[chargebee-worker] ${signal} received, draining...`);
	// abort: false => let in-flight handlers finish before stopping.
	consumer.stop({ abort: true });
	void usageFlush?.stop();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

consumer.start();
console.log(`[chargebee-worker] polling ${queueUrl}`);
