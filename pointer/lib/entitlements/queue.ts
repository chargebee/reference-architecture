/**
 * App-originated entitlement sync jobs.
 *
 * The subscription-created webhook enqueues one of these after its local
 * subscription row exists, so the worker warms the entitlement mirror
 * (PostgreSQL + Redis) off the webhook-processing path.
 *
 * The job rides the Chargebee webhook queue so the worker keeps a single
 * consumer loop, retry budget, and DLQ. `job` discriminates it from a
 * Chargebee `WebhookEvent`, which carries `event_type` instead.
 *
 * Enqueue-only by design: the handler lives in `sync.ts` so importing this from
 * `lib/auth.ts` doesn't pull the provider (Redis, PostgreSQL, Chargebee) into
 * the auth config's import graph.
 */

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { v7 as uuidv7 } from "uuid";

import { emit } from "@/lib/events/emit";
import { getSqsClient, getWebhookQueueUrl, isFifoQueue } from "@/lib/queue";

export const ENTITLEMENT_SYNC_JOB = "entitlements.sync";

export type EntitlementSyncJobReason = "subscription_created" | "manual";

export interface EntitlementSyncJob {
	job: typeof ENTITLEMENT_SYNC_JOB;
	/** Doubles as the trace id for every event the job emits. */
	id: string;
	requestedAt: string;
	reason: EntitlementSyncJobReason;
	chargebeeSubscriptionId: string;
}

export function isEntitlementSyncJob(
	value: unknown,
): value is EntitlementSyncJob {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<EntitlementSyncJob>;
	return (
		candidate.job === ENTITLEMENT_SYNC_JOB &&
		typeof candidate.id === "string" &&
		typeof candidate.requestedAt === "string" &&
		(candidate.reason === "subscription_created" ||
			candidate.reason === "manual") &&
		typeof candidate.chargebeeSubscriptionId === "string"
	);
}

export async function enqueueEntitlementSync(
	input: Omit<EntitlementSyncJob, "job" | "id" | "requestedAt">,
): Promise<EntitlementSyncJob> {
	const job: EntitlementSyncJob = {
		job: ENTITLEMENT_SYNC_JOB,
		id: uuidv7(),
		requestedAt: new Date().toISOString(),
		...input,
	};

	const queueUrl = getWebhookQueueUrl();
	const fifo = isFifoQueue(queueUrl);

	await getSqsClient().send(
		new SendMessageCommand({
			QueueUrl: queueUrl,
			MessageBody: JSON.stringify(job),
			MessageDeduplicationId: fifo ? job.id : undefined,
			MessageGroupId: fifo ? "chargebee-webhooks" : undefined,
		}),
	);

	await emit(
		"app.entitlements_sync_queued",
		{
			job_id: job.id,
			reason: job.reason,
			chargebee_subscription_id: job.chargebeeSubscriptionId,
		},
		{ source: "app", trace_id: job.id },
	);

	return job;
}
