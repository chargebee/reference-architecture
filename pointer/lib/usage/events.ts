/**
 * The domain write API for usage tracking.
 *
 * `recordUsageEvent` is the only thing the generation path calls. It knows
 * nothing about Redis or Chargebee — it hands a finished generation to the
 * buffer and returns. The flush loop turns buffered events into Chargebee
 * batches later.
 *
 * Recording is best-effort by design, exactly like `lib/events/emit.ts`: a
 * subscriber's generation must never fail because telemetry could not be
 * written.
 */

import type { UsageEventProperties } from "@/scripts/catalog";
import process from "node:process";

/**
 * A generation, as buffered. Mirrors the batch-ingest wire shape so the flush
 * path is a projection rather than a translation.
 *
 * `usageTimestamp` is captured at record time, not flush time — Chargebee bills
 * against when the usage happened, and its 12-hour backdating window is
 * measured from this value.
 */
export type BufferedUsageEvent = {
	/**
	 * Chargebee's `deduplication_id`, capped at 36 characters. The generation's
	 * uuidv7 trace id is exactly 36, and already unique per request, so a
	 * replayed batch collapses to a no-op on Chargebee's side.
	 */
	deduplicationId: string;
	subscriptionId: string;
	/** Epoch milliseconds, as the ingest API requires. */
	usageTimestamp: number;
	properties: UsageEventProperties;
};

/**
 * Usage tracking stays dark until a Chargebee site has Advanced Usage Based
 * Billing switched on and the meters bootstrapped, so local development and
 * unconfigured environments neither buffer events nor start the flush loop.
 */
export function usageIngestEnabled(): boolean {
	return process.env.CHARGEBEE_USAGE_INGEST_ENABLED === "true";
}

export async function recordUsageEvent(
	event: BufferedUsageEvent,
): Promise<void> {
	if (!usageIngestEnabled()) return;

	try {
		// Lazy-imported for the same reason as the event bus: keep ioredis out of
		// the static import graph of the generation path.
		const { appendUsageEvent } = await import("./stream");
		await appendUsageEvent(event);
	} catch (err) {
		console.error(
			`[usage] failed to buffer event ${event.deduplicationId}`,
			err,
		);
	}
}
