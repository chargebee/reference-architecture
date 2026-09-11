/**
 * Chargebee batch-ingest driver.
 *
 * Turns buffered entries into `usageEvent.batchIngest` calls and reports which
 * ones landed. Deliberately free of Redis: it classifies and calls, and
 * `flush.ts` decides what to acknowledge or park. The SDK routes this to
 * `{site}.ingest.chargebee.com` on its own — no separate client is needed.
 */

import { chargebeeClient } from "@/plugins/chargebee-plugin";

import type { UsageStreamEntry } from "./stream";

/**
 * Chargebee rejects any `usage_timestamp` older than 12 hours. Events are
 * expired an hour early so a batch that is retried near the boundary cannot be
 * accepted on one attempt and rejected on the next.
 */
const BACKDATING_WINDOW_MS = 12 * 60 * 60 * 1_000;
const EXPIRY_MARGIN_MS = 60 * 60 * 1_000;
export const MAX_EVENT_AGE_MS = BACKDATING_WINDOW_MS - EXPIRY_MARGIN_MS;

/** Attempts before an entry is parked. Covers a transient Chargebee outage. */
export const MAX_DELIVERIES = 5;

export type ExpirySplit = {
	fresh: UsageStreamEntry[];
	expired: UsageStreamEntry[];
};

/**
 * Splits off events Chargebee will refuse on age alone. Retrying these is
 * pointless — the window only ever moves further away from them.
 */
export function splitExpired(
	entries: UsageStreamEntry[],
	now = Date.now(),
): ExpirySplit {
	const fresh: UsageStreamEntry[] = [];
	const expired: UsageStreamEntry[] = [];

	for (const entry of entries) {
		const age = now - entry.event.usageTimestamp;
		if (age > MAX_EVENT_AGE_MS) {
			expired.push(entry);
			continue;
		}
		fresh.push(entry);
	}

	return { fresh, expired };
}

/** Splits off entries that have failed too often to be worth another attempt. */
export function splitExhausted(entries: UsageStreamEntry[]): {
	retryable: UsageStreamEntry[];
	exhausted: UsageStreamEntry[];
} {
	return {
		retryable: entries.filter((entry) => entry.deliveries <= MAX_DELIVERIES),
		exhausted: entries.filter((entry) => entry.deliveries > MAX_DELIVERIES),
	};
}

/**
 * `failed_events` is schemaless in the API contract. The deduplication id is
 * the only field we need, and it may sit at the top level or under the echoed
 * event, so both are probed.
 */
function failedDeduplicationIds(failed: unknown): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(failed)) return ids;

	for (const item of failed) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const nested = record.usage_event as Record<string, unknown> | undefined;
		const id = record.deduplication_id ?? nested?.deduplication_id;
		if (typeof id === "string") ids.add(id);
	}

	return ids;
}

export type IngestResult = {
	batchId: string | null;
	ingested: UsageStreamEntry[];
	failed: UsageStreamEntry[];
};

/**
 * Ingests one batch. A partial failure acknowledges the events that landed and
 * returns the rest for another attempt; when Chargebee reports failures without
 * identifying them, the whole batch is retried, which is safe because it
 * deduplicates on (deduplication_id, subscription_id, usage_timestamp).
 */
export async function ingestBatch(
	entries: UsageStreamEntry[],
): Promise<IngestResult> {
	if (!entries.length) {
		return { batchId: null, ingested: [], failed: [] };
	}

	const response = await chargebeeClient.usageEvent.batchIngest({
		events: entries.map((entry) => ({
			deduplication_id: entry.event.deduplicationId,
			subscription_id: entry.event.subscriptionId,
			usage_timestamp: entry.event.usageTimestamp,
			properties: entry.event.properties,
		})),
	});

	const failedIds = failedDeduplicationIds(response.failed_events);
	const unidentified =
		Array.isArray(response.failed_events) &&
		response.failed_events.length > 0 &&
		failedIds.size === 0;

	if (unidentified) {
		console.error(
			"[usage-ingest] Chargebee reported unidentified failures",
			response.failed_events,
		);
		return { batchId: response.batch_id, ingested: [], failed: entries };
	}

	return {
		batchId: response.batch_id,
		ingested: entries.filter(
			(entry) => !failedIds.has(entry.event.deduplicationId),
		),
		failed: entries.filter((entry) =>
			failedIds.has(entry.event.deduplicationId),
		),
	};
}
