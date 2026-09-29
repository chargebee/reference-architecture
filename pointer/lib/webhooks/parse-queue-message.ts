import type { WebhookEvent } from "chargebee";

import {
	type EntitlementSyncJob,
	isEntitlementSyncJob,
} from "@/lib/entitlements/queue";
import { PoisonWebhookError } from "@/lib/webhooks/webhook-errors";

export type ParsedQueueMessage =
	| { kind: "entitlement_sync"; job: EntitlementSyncJob }
	| { kind: "chargebee_event"; event: WebhookEvent }
	| { kind: "poison"; error: PoisonWebhookError };

export function parseQueueMessage(bodyText: string): ParsedQueueMessage {
	let body: unknown;

	try {
		body = JSON.parse(bodyText);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);

		return {
			kind: "poison",
			error: new PoisonWebhookError(`unparseable webhook body: ${reason}`),
		};
	}

	if (isEntitlementSyncJob(body)) {
		return { kind: "entitlement_sync", job: body };
	}

	const event = body as WebhookEvent;
	if (!event || typeof event.id !== "string") {
		return {
			kind: "poison",
			error: new PoisonWebhookError("webhook body is missing an event id"),
		};
	}

	return { kind: "chargebee_event", event };
}
