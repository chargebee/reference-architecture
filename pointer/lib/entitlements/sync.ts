import type { WebhookEvent } from "chargebee";

import { getPool } from "@/lib/db";
import { emit } from "@/lib/events/emit";

import { entitlements } from "./provider";
import {
  enqueueEntitlementSync,
  type EntitlementSyncJob,
} from "./queue";
import { recordEntitlementSyncSource } from "./postgres-store";

const DIRECT_EVENTS = new Set([
  "subscription_entitlements_created",
  "subscription_entitlements_updated",
]);

// The Better Auth processor creates the local subscription and item rows first.
// Queue the Chargebee entitlement fetch afterwards instead of trying to warm a
// subscription that did not exist when the user originally signed up.
const SUBSCRIPTION_QUEUE_EVENTS = new Set([
  "subscription_created",
  "subscription_created_with_backdating",
]);

// Anything that can change which plan items — and therefore which entitlements
// — a subscription carries. Backdated variants are separate Chargebee events.
const SUBSCRIPTION_REFRESH_EVENTS = new Set([
  "subscription_activated",
  "subscription_activated_with_backdating",
  "subscription_started",
  "subscription_changed",
  "subscription_changed_with_backdating",
  "subscription_renewed",
  "subscription_items_renewed",
  "subscription_reactivated",
  "subscription_reactivated_with_backdating",
  "subscription_resumed",
  "subscription_paused",
  "subscription_ramp_applied",
  "subscription_moved_in",
]);

// The subscription no longer grants anything, so the mirror row and the cached
// copy both go: the next evaluation falls back to free-tier defaults instead of
// the entitlements the subscription used to have.
const SUBSCRIPTION_DELETE_EVENTS = new Set([
  "subscription_cancelled",
  "subscription_canceled_with_backdating",
  "subscription_deleted",
  "subscription_moved_out",
]);

const IMPACT_EVENTS = new Set([
  "entitlement_overrides_updated",
  "entitlement_overrides_removed",
  "entitlement_overrides_auto_removed",
  "item_entitlements_updated",
  "item_entitlements_removed",
  "item_price_entitlements_updated",
  "item_price_entitlements_removed",
]);

type EventContent = Record<string, unknown>;

async function assertLocalSubscription(
  chargebeeSubscriptionId: string,
): Promise<void> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT 1 FROM subscription
      WHERE "chargebeeSubscriptionId" = $1
      LIMIT 1`,
    [chargebeeSubscriptionId],
  );
  if (!result.rows[0]) {
    throw new Error(
      `Subscription ${chargebeeSubscriptionId} is not present in the local mirror`,
    );
  }
}

export type EntitlementSyncTrigger =
  | "webhook"
  | "checkout"
  | "reconcile";

/**
 * Refetches a subscription's entitlements from Chargebee and rewrites the
 * mirror. `refreshSnapshot` drops the Redis copy before it fetches, so a
 * webhook that changed entitlements can't be shadowed by the cached values it
 * invalidated: reads fall through to PostgreSQL until the fresh snapshot lands.
 */
export async function syncSubscriptionEntitlements(
  chargebeeSubscriptionId: string,
  options: {
    sourceEvent?: Pick<WebhookEvent, "id" | "event_type">;
    trigger?: EntitlementSyncTrigger;
    traceId?: string;
  } = {},
): Promise<void> {
  const {
    sourceEvent,
    traceId,
    trigger = sourceEvent ? "webhook" : "reconcile",
  } = options;
  const trace = sourceEvent?.id ?? traceId;
  try {
    await assertLocalSubscription(chargebeeSubscriptionId);
    const result = await entitlements.refreshSnapshot({
      subscriptionId: chargebeeSubscriptionId,
    });
    if (sourceEvent?.id && sourceEvent.event_type) {
      await recordEntitlementSyncSource(chargebeeSubscriptionId, {
        id: sourceEvent.id,
        event_type: String(sourceEvent.event_type),
      });
    }
    await emit(
      "chargebee.entitlements_synced",
      {
        subscription_id: chargebeeSubscriptionId,
        feature_count: Object.keys(result.snapshot.entitlements).length,
        source_event_id: sourceEvent?.id,
        source_event_type: sourceEvent?.event_type,
        generated_at: result.snapshot.generatedAt,
        trigger,
      },
      { source: "worker", trace_id: trace },
    );
  } catch (error) {
    await emit(
      "chargebee.entitlements_sync_failed",
      {
        subscription_id: chargebeeSubscriptionId,
        source_event_id: sourceEvent?.id,
        source_event_type: sourceEvent?.event_type,
        trigger,
        reason: error instanceof Error ? error.message : String(error),
      },
      { source: "worker", trace_id: trace },
    );
    throw error;
  }
}

/** Runs a subscription-specific sync job queued by `subscription_created`. */
export async function runEntitlementSyncJob(
  job: EntitlementSyncJob,
): Promise<void> {
  await syncSubscriptionEntitlements(job.chargebeeSubscriptionId, {
    trigger: job.reason === "subscription_created" ? "webhook" : "reconcile",
    traceId: job.id,
  });
}

async function deleteSubscriptionEntitlements(
  chargebeeSubscriptionId: string,
): Promise<void> {
  await entitlements.deleteSnapshot({
    subscriptionId: chargebeeSubscriptionId,
  });
}

function directSubscriptionId(content: EventContent): string | null {
  for (const key of [
    "subscription_entitlements_created_detail",
    "subscription_entitlements_updated_detail",
  ]) {
    const detail = content[key];
    if (
      detail &&
      typeof detail === "object" &&
      typeof (detail as { subscription_id?: unknown }).subscription_id ===
        "string"
    ) {
      return (detail as { subscription_id: string }).subscription_id;
    }
  }
  const subscription = content.subscription;
  if (
    subscription &&
    typeof subscription === "object" &&
    typeof (subscription as { id?: unknown }).id === "string"
  ) {
    return (subscription as { id: string }).id;
  }
  return null;
}

function normalizeIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === "string");
  }
  if (typeof value !== "string") return [];
  try {
    return normalizeIds(JSON.parse(value));
  } catch {
    return value
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
  }
}

function collectIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const direct = normalizeIds(object.subscription_ids);
  return [
    ...direct,
    ...Object.entries(object)
      .filter(([key]) => key !== "subscription_ids")
      .flatMap(([, child]) => collectIds(child)),
  ];
}

async function impactedSubscriptionIds(content: EventContent): Promise<string[]> {
  const impacted = content.impacted_subscription as
    | {
        count?: number;
        subscription_ids?: unknown;
        download?: { download_url?: string };
      }
    | undefined;
  if (!impacted) return [];

  const inline = normalizeIds(impacted.subscription_ids);
  if (inline.length > 0) return [...new Set(inline)];
  const url = impacted.download?.download_url;
  if (!url) {
    if ((impacted.count ?? 0) > 0) {
      throw new Error("Impacted subscriptions are missing a download URL");
    }
    return [];
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Unable to download impacted subscriptions (${response.status})`,
    );
  }
  const text = await response.text();
  let ids: string[];
  try {
    ids = collectIds(JSON.parse(text));
  } catch {
    ids = normalizeIds(text);
  }
  return [...new Set(ids)];
}

async function eachWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const value = values[index];
        index += 1;
        if (value !== undefined) await task(value);
      }
    }),
  );
}

export async function processEntitlementWebhook(
  event: WebhookEvent,
): Promise<boolean> {
  const eventType = String(event.event_type);
  const content = (event.content ?? {}) as EventContent;

  if (SUBSCRIPTION_DELETE_EVENTS.has(eventType)) {
    const subscriptionId = directSubscriptionId(content);
    if (subscriptionId) await deleteSubscriptionEntitlements(subscriptionId);
    return Boolean(subscriptionId);
  }

  if (SUBSCRIPTION_QUEUE_EVENTS.has(eventType)) {
    const subscriptionId = directSubscriptionId(content);
    if (!subscriptionId) {
      throw new Error(`${eventType} did not include a subscription id`);
    }
    await enqueueEntitlementSync({
      reason: "subscription_created",
      chargebeeSubscriptionId: subscriptionId,
    });
    return true;
  }

  if (DIRECT_EVENTS.has(eventType) || SUBSCRIPTION_REFRESH_EVENTS.has(eventType)) {
    const subscriptionId = directSubscriptionId(content);
    if (!subscriptionId) {
      throw new Error(`${eventType} did not include a subscription id`);
    }
    await syncSubscriptionEntitlements(subscriptionId, { sourceEvent: event });
    return true;
  }

  if (!IMPACT_EVENTS.has(eventType)) return false;
  const subscriptionIds = await impactedSubscriptionIds(content);
  await eachWithConcurrency(subscriptionIds, 5, (subscriptionId) =>
    syncSubscriptionEntitlements(subscriptionId, { sourceEvent: event }),
  );
  return true;
}
