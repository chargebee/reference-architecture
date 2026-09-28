import type { WebhookEvent } from "chargebee";

import { processAlertWebhook } from "@/lib/alerts/sync";
import { processEntitlementWebhook } from "@/lib/entitlements/sync";
import { emit } from "@/lib/events/emit";
import {
	assertDependencies,
	assertProcessed,
	commitVersions,
	isEventStale,
} from "@/lib/webhooks/webhook-guards";

export enum ChargebeeEventOutcome {
	Stale = "stale",
	ProcessedAlert = "processed-alert",
	ProcessedStandard = "processed-standard",
}

export interface ChargebeePluginProcessor {
	process(event: WebhookEvent): Promise<void>;
}

export interface ChargebeePipelineContext {
	sqsMessageId?: string;
}

async function emitProcessed(
	event: WebhookEvent,
	context: ChargebeePipelineContext,
): Promise<void> {
	await emit(
		"chargebee.webhook_processed",
		{
			webhook_event_type: event.event_type,
			webhook_event_id: event.id,
			occurred_at: event.occurred_at,
			sqs_message_id: context.sqsMessageId,
		},
		{ source: "worker", trace_id: event.id },
	);
}

/**
 * Apply webhook ordering, processing, verification, and versioning.
 * Queue retry and dead-letter policy remain in the worker adapter.
 */
export async function runChargebeeEventPipeline(
	event: WebhookEvent,
	plugin: ChargebeePluginProcessor,
	context: ChargebeePipelineContext = {},
): Promise<ChargebeeEventOutcome> {
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

		return ChargebeeEventOutcome.Stale;
	}

	const handledAsAlert = await processAlertWebhook(event);
	if (!handledAsAlert) {
		await assertDependencies(event);
		await plugin.process(event);
		await assertProcessed(event);
		await processEntitlementWebhook(event);
	}

	await commitVersions(event);
	await emitProcessed(event, context);

	return handledAsAlert
		? ChargebeeEventOutcome.ProcessedAlert
		: ChargebeeEventOutcome.ProcessedStandard;
}
