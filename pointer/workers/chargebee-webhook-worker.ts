/**
 * Chargebee webhook worker.
 *
 * Long-polls the Chargebee webhook SQS queue and processes each message with
 * the Better Auth Chargebee plugin's DB-sync hooks via
 * `createChargebeeWebhookProcessor`, wrapped in a correctness pipeline that
 * the plugin itself can't provide.
 *
 * # Per-message pipeline (handleMessage)
 *
 *   parse ─▶ stale/duplicate guard ─▶ dependency pre-check ─▶ process
 *         ─▶ verify-after-process ─▶ commit versions ─▶ ack
 *
 * Idempotency needs no inbox: SQS is at-least-once, but our hooks are
 * idempotent and the `resource_version` guard turns a redelivered/stale event
 * into a skip. See docs/plans/5-webhook-correctness.md.
 *
 * # Error handling
 *
 *   - RetryableWebhookError (dependency-not-ready / transient / silent-failure)
 *     -> increasing backoff via ChangeMessageVisibility, then rethrow so
 *        sqs-consumer leaves the message on the queue. After maxReceiveCount=5
 *        SQS auto-routes it to the DLQ.
 *   - PoisonWebhookError (malformed / unprocessable) -> send to the DLQ
 *     explicitly and ack, skipping the retry budget.
 *   - Unknown errors -> treated as retryable (safer default).
 *
 * # Horizontal scaling
 *
 *   Adding more workers = run more processes / ECS tasks. SQS fans messages out
 *   across consumers; the visibility timeout prevents two workers from
 *   processing the same message. No leader election required.
 */

import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  createChargebeeWebhookProcessor,
  type ChargebeeWebhookProcessorSource,
} from "@chargebee/better-auth";
import type { Message } from "@aws-sdk/client-sqs";
import type { WebhookEvent } from "chargebee";
import { Consumer } from "sqs-consumer";

import { auth } from "@/lib/auth";
import { chargebeePluginOptions } from "@/plugins/chargebee-plugin";
import { emit } from "@/lib/events/emit";
import {
  PoisonWebhookError,
  RetryableWebhookError,
} from "@/lib/webhooks/webhook-errors";
import {
  assertDependencies,
  assertProcessed,
  commitVersions,
  isEventStale,
} from "@/lib/webhooks/webhook-guards";

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

const processorPromise = auth.$context.then((ctx) =>
  createChargebeeWebhookProcessor(chargebeePluginOptions, {
    context: { adapter: ctx.adapter, logger: ctx.logger },
  } as unknown as ChargebeeWebhookProcessorSource),
);

// Increasing backoff keyed off the SQS receive count so a dependency-not-ready
// message waits progressively longer (30s -> 1m -> 2m -> ... capped at 15m)
// instead of burning its retry budget in a burst.
function backoffSeconds(receiveCount: number): number {
  return Math.min(30 * 2 ** Math.max(0, receiveCount - 1), 900);
}

async function applyBackoff(
  message: Message,
  receiveCount: number,
): Promise<void> {
  if (!message.ReceiptHandle) return;
  try {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: backoffSeconds(receiveCount),
      }),
    );
  } catch (err) {
    // Non-fatal: the message just becomes visible again after the default
    // visibility timeout instead of the backed-off one.
    console.error("[chargebee-worker] failed to extend visibility", err);
  }
}

// Route a poison message straight to the DLQ and ack the main queue. If the
// DLQ send fails we rethrow so the message is retried rather than lost.
async function routePoison(
  message: Message,
  event: WebhookEvent | undefined,
  err: unknown,
): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  console.error("[chargebee-worker] poison message -> DLQ", {
    messageId: message.MessageId,
    eventId: event?.id,
    reason,
  });
  await emit(
    "chargebee.webhook_dead_lettered",
    {
      webhook_event_type: event?.event_type,
      webhook_event_id: event?.id,
      sqs_message_id: message.MessageId,
      reason,
    },
    { source: "worker", trace_id: event?.id },
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: dlqUrl,
      MessageBody: message.Body ?? "{}",
    }),
  );
}

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
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? "1",
    );

    // 1. Parse. Malformed body / missing id is poison — never retryable.
    let event: WebhookEvent;
    try {
      const parsed = JSON.parse(message.Body ?? "{}") as WebhookEvent;
      if (!parsed || typeof parsed.id !== "string") {
        throw new Error("missing event id");
      }
      event = parsed;
    } catch (err) {
      await routePoison(
        message,
        undefined,
        new PoisonWebhookError(
          `unparseable webhook body: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return message; // ack: poison routed to DLQ
    }

    console.log("[chargebee-worker]", {
      messageId: message.MessageId,
      eventId: event.id,
      eventType: event.event_type,
      occurredAt: event.occurred_at,
      receiveCount,
    });

    try {
      // 2. Stale / duplicate guard.
      if (await isEventStale(event)) {
        await emit(
          "chargebee.webhook_skipped_stale",
          {
            webhook_event_type: event.event_type,
            webhook_event_id: event.id,
            occurred_at: event.occurred_at,
          },
          { source: "worker", trace_id: event.id },
        );
        return message; // ack: nothing new to apply
      }

      // 3. Dependency pre-check (throws RetryableWebhookError when not ready).
      await assertDependencies(event);

      // 4. Process (plugin DB-sync hooks).
      await (await processorPromise).process(event);

      // 5. Verify-after-process (catches the plugin's swallowed errors).
      await assertProcessed(event);

      // 6. Commit applied versions, emit, ack.
      await commitVersions(event);
      await emit(
        "chargebee.webhook_processed",
        {
          webhook_event_type: event.event_type,
          webhook_event_id: event.id,
          occurred_at: event.occurred_at,
          sqs_message_id: message.MessageId,
        },
        { source: "worker", trace_id: event.id },
      );

      return message; // ack
    } catch (err) {
      if (err instanceof PoisonWebhookError) {
        await routePoison(message, event, err);
        return message; // ack: poison routed to DLQ
      }

      // Retryable + unknown errors: back off and leave the message on the
      // queue (throwing prevents sqs-consumer from deleting it).
      await applyBackoff(message, receiveCount);
      await emit(
        "chargebee.webhook_retry_scheduled",
        {
          webhook_event_type: event.event_type,
          webhook_event_id: event.id,
          occurred_at: event.occurred_at,
          receive_count: receiveCount,
          backoff_seconds: backoffSeconds(receiveCount),
          reason: err instanceof Error ? err.message : String(err),
        },
        { source: "worker", trace_id: event.id },
      );

      throw err instanceof RetryableWebhookError
        ? err
        : new RetryableWebhookError(
            err instanceof Error ? err.message : String(err),
            { cause: err },
          );
    }
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
console.log(`[chargebee-worker] polling ${queueUrl}`);
