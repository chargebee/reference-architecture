import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  createChargebeeWebhookProcessor,
  type ChargebeeWebhookProcessorSource,
} from "@chargebee/better-auth";
import type { WebhookEvent } from "chargebee";

import { auth } from "@/lib/auth";
import {
  type EntitlementSyncJob,
  isEntitlementSyncJob,
} from "@/lib/entitlements/queue";
import {
  processEntitlementWebhook,
  runEntitlementSyncJob,
} from "@/lib/entitlements/sync";
import { processAlertWebhook } from "@/lib/alerts/sync";
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
import { chargebeePluginOptions } from "@/plugins/chargebee-plugin";

export interface ChargebeeWebhookMessageProcessorOptions {
  queueUrl: string;
  dlqUrl: string;
  sqs?: SQSClient;
}

export type ChargebeeWebhookMessageProcessor = (
  message: Message,
) => Promise<void>;

// Increasing backoff keyed off the SQS receive count so a
// dependency-not-ready message waits progressively longer
// (30s -> 1m -> 2m -> ... capped at 15m).
export function backoffSeconds(receiveCount: number): number {
  return Math.min(30 * 2 ** Math.max(0, receiveCount - 1), 900);
}

export function createChargebeeWebhookMessageProcessor({
  queueUrl,
  dlqUrl,
  sqs = new SQSClient(),
}: ChargebeeWebhookMessageProcessorOptions): ChargebeeWebhookMessageProcessor {
  const processorPromise = auth.$context.then((ctx) =>
    createChargebeeWebhookProcessor(chargebeePluginOptions, {
      context: { adapter: ctx.adapter, logger: ctx.logger },
    } as unknown as ChargebeeWebhookProcessorSource),
  );

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
      // Non-fatal: the message becomes visible after the queue's default
      // visibility timeout instead of the backed-off one.
      console.error("[chargebee-worker] failed to extend visibility", err);
    }
  }

  // Route a poison message straight to the DLQ and let the runtime acknowledge
  // the source message. If the DLQ send fails, the error escapes so the source
  // message is retried rather than lost.
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

  async function runSyncJob(
    job: EntitlementSyncJob,
    message: Message,
    receiveCount: number,
  ): Promise<void> {
    console.log("[chargebee-worker]", {
      messageId: message.MessageId,
      jobId: job.id,
      job: job.job,
      reason: job.reason,
      subscriptionId: job.chargebeeSubscriptionId,
      receiveCount,
    });

    try {
      await runEntitlementSyncJob(job);
    } catch (err) {
      await applyBackoff(message, receiveCount);
      throw err instanceof RetryableWebhookError
        ? err
        : new RetryableWebhookError(
            err instanceof Error ? err.message : String(err),
            { cause: err },
          );
    }
  }

  return async function processMessage(message: Message): Promise<void> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? "1",
    );

    // 1. Parse. Malformed body / missing id is poison — never retryable.
    let body: unknown;
    try {
      body = JSON.parse(message.Body ?? "{}");
    } catch (err) {
      await routePoison(
        message,
        undefined,
        new PoisonWebhookError(
          `unparseable webhook body: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    // App-originated jobs share the queue; they carry `job`, not `event_type`.
    if (isEntitlementSyncJob(body)) {
      await runSyncJob(body, message, receiveCount);
      return;
    }

    const event = body as WebhookEvent;
    if (!event || typeof event.id !== "string") {
      await routePoison(
        message,
        undefined,
        new PoisonWebhookError("webhook body is missing an event id"),
      );
      return;
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
        return;
      }

      // 3a. Handle alert status changes — processed before assertDependencies
      //     because alert_status_changed events are global and do not require
      //     the subscription to exist in the local DB mirror yet.
      if (await processAlertWebhook(event)) {
        // Alert events don't need the rest of the subscription pipeline.
        // Fall through to commitVersions + webhook_processed below.
      } else {
        // 3b. Dependency pre-check (throws RetryableWebhookError when not ready).
        await assertDependencies(event);

        // 4. Process (plugin DB-sync hooks).
        await (await processorPromise).process(event);

        // 5. Verify the plugin's swallowed errors before an entitlement job can
        // observe a subscription-created event as successfully mirrored.
        await assertProcessed(event);

        // 6. Refresh or queue the resolved entitlement mirror.
        await processEntitlementWebhook(event);
      }

      // 7. Commit applied versions, emit, and let the runtime acknowledge.
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
    } catch (err) {
      if (err instanceof PoisonWebhookError) {
        await routePoison(message, event, err);
        return;
      }

      // Retryable + unknown errors: back off and throw so ECS leaves the
      // message on the queue or Lambda reports a partial batch failure.
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
  };
}
