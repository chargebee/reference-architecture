/**
 * Correctness guards for Chargebee webhook processing.
 *
 * These wrap `processor.process()` in the worker to add the guarantees the
 * plugin can't: out-of-order overwrite protection, duplicate-delivery
 * tolerance, dependency ordering, and a swallowed-error safety net. They are
 * backed by the `chargebee_resource_version` table (see
 * scripts/migrate-webhooks.ts) plus the Better Auth `subscription` / `user` /
 * `organization` tables.
 */
import type { WebhookEvent } from "chargebee";
import { v7 as uuidv7 } from "uuid";

import { getPool } from "@/lib/db";
import { RetryableWebhookError } from "@/lib/webhooks/webhook-errors";

// Composite key stored in the unique `resourceKey` column of
// chargebee_resource_version (Better Auth can't express a composite PK).
function resourceKey(resourceType: string, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

/**
 * A resource inside a webhook `content` that carries a monotonic
 * `resource_version`. Chargebee bumps this on every change, so it is the
 * ordering key for out-of-order (and duplicate) delivery.
 */
export interface VersionedResource {
  resourceType: string; // content key, e.g. "customer" | "subscription"
  resourceId: string;
  resourceVersion: number;
}

function isVersioned(
  value: unknown,
): value is { id: string; resource_version: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { resource_version?: unknown }).resource_version ===
      "number"
  );
}

/**
 * Collect every resource in an event's `content` that has an `id` + numeric
 * `resource_version`. Handles both single objects (e.g. `customer`) and arrays
 * (e.g. `credit_note`, `unbilled_charge`).
 */
export function versionedResources(event: WebhookEvent): VersionedResource[] {
  const content = (event.content ?? {}) as Record<string, unknown>;
  const out: VersionedResource[] = [];
  for (const [key, value] of Object.entries(content)) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (isVersioned(candidate)) {
        out.push({
          resourceType: key,
          resourceId: candidate.id,
          resourceVersion: candidate.resource_version,
        });
      }
    }
  }
  return out;
}

async function storedVersion(
  resourceType: string,
  resourceId: string,
): Promise<number | undefined> {
  const pool = await getPool();
  const { rows } = await pool.query<{ resourceVersion: string }>(
    `SELECT "resourceVersion" FROM chargebee_resource_version
      WHERE "resourceKey" = $1`,
    [resourceKey(resourceType, resourceId)],
  );
  const stored = rows[0]?.resourceVersion;
  return stored === undefined ? undefined : Number(stored);
}

/** A resource is stale when we've already applied an equal-or-newer version. */
export async function isStale(
  resourceType: string,
  resourceId: string,
  incomingVersion: number,
): Promise<boolean> {
  const stored = await storedVersion(resourceType, resourceId);
  if (stored === undefined) return false;
  return incomingVersion <= stored;
}

/**
 * True only when the event carries at least one versioned resource and *every*
 * one is already at or behind the stored version — i.e. the whole event is a
 * stale replay or a duplicate delivery and can be safely skipped. Events with
 * no versioned resources return false (nothing to compare, process normally).
 */
export async function isEventStale(event: WebhookEvent): Promise<boolean> {
  const resources = versionedResources(event);
  if (resources.length === 0) return false;
  const results = await Promise.all(
    resources.map((r) =>
      isStale(r.resourceType, r.resourceId, r.resourceVersion),
    ),
  );
  return results.every(Boolean);
}

/**
 * Record the applied `resource_version` for every resource in the event. The
 * conditional upsert only advances the stored version, so a late/duplicate
 * event can never roll it back.
 */
export async function commitVersions(event: WebhookEvent): Promise<void> {
  const resources = versionedResources(event);
  if (resources.length === 0) return;
  const pool = await getPool();
  for (const r of resources) {
    await pool.query(
      // Better Auth's CLI creates an `id` text PK with no DB default (app-layer
      // id generation), so we supply one; it's ignored on the conflict path.
      `INSERT INTO chargebee_resource_version
              ("id", "resourceKey", "resourceVersion")
            VALUES ($1, $2, $3)
       ON CONFLICT ("resourceKey")
       DO UPDATE SET "resourceVersion" = EXCLUDED."resourceVersion",
                     "updatedAt" = now()
             WHERE EXCLUDED."resourceVersion"
                   > chargebee_resource_version."resourceVersion"`,
      [uuidv7(), resourceKey(r.resourceType, r.resourceId), r.resourceVersion],
    );
  }
}

async function customerExists(chargebeeCustomerId: string): Promise<boolean> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM "user"         WHERE "chargebeeCustomerId" = $1
      UNION ALL
     SELECT 1 FROM "organization" WHERE "chargebeeCustomerId" = $1
      LIMIT 1`,
    [chargebeeCustomerId],
  );
  return rows.length > 0;
}

async function subscriptionExists(
  chargebeeSubscriptionId: string,
): Promise<boolean> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM subscription
      WHERE "chargebeeSubscriptionId" = $1 LIMIT 1`,
    [chargebeeSubscriptionId],
  );
  return rows.length > 0;
}

/** Parent ids referenced anywhere in an event's `content`. */
interface DependencyRefs {
  customerIds: Set<string>;
  subscriptionIds: Set<string>;
}

/**
 * Walk every object in an event's `content` (top-level and nested, single or
 * array) and collect the customer / subscription ids it references — both
 * embedded parent objects (`content.customer.id`, `content.subscription.id`)
 * and the foreign keys child resources carry (`subscription.customer_id`,
 * `invoice.customer_id`, `invoice.subscription_id`, `transaction.customer_id`,
 * `credit_note.customer_id`, …).
 */
function collectDependencyRefs(
  content: Record<string, unknown>,
): DependencyRefs {
  const customerIds = new Set<string>();
  const subscriptionIds = new Set<string>();

  for (const [key, value] of Object.entries(content)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;

      // An embedded parent object references itself by `id`.
      if (key === "customer" && typeof rec.id === "string") {
        customerIds.add(rec.id);
      }
      if (key === "subscription" && typeof rec.id === "string") {
        subscriptionIds.add(rec.id);
      }

      // Any resource can carry a foreign key up to its parent(s).
      if (typeof rec.customer_id === "string") customerIds.add(rec.customer_id);
      if (typeof rec.subscription_id === "string") {
        subscriptionIds.add(rec.subscription_id);
      }
    }
  }

  return { customerIds, subscriptionIds };
}

/** Resource types the event itself owns (creates/updates) — never gated. */
function eventSubjects(eventType: string | undefined): {
  customer: boolean;
  subscription: boolean;
} {
  const type = eventType ?? "";
  return {
    customer: type.startsWith("customer_"),
    subscription: type.startsWith("subscription_"),
  };
}

/**
 * Generalized out-of-order dependency gate.
 *
 * Chargebee delivers events with no ordering guarantee, so any resource can
 * reference a parent (customer/subscription) whose own `*_created` event hasn't
 * been processed yet — not just the subscription→customer case. Rather than
 * special-casing one event shape, we scan every object in `content` for the
 * parent ids it references and require each to already exist in our DB. If one
 * is missing we throw `RetryableWebhookError` so the message stays on the queue
 * and is retried once the prerequisite lands (see
 * how-to/integrating-chargebee-webhooks.md → "Handling out-of-order and
 * dependent events"). This covers `payment_succeeded`, `invoice_generated`,
 * `credit_note_created`, etc. arriving before their customer/subscription.
 *
 * Exemptions that keep this from dead-locking on the resource the event itself
 * introduces:
 *   - The event's own subject is skipped: a `customer_*` event creates the
 *     customer and a `subscription_*` event creates the subscription, so
 *     requiring them to pre-exist would block every create. Whether the subject
 *     is fresh enough to apply is already handled by `isEventStale` +
 *     `commitVersions` (the resource-version guard).
 *   - `customer_*` events embed a subscription list (e.g. `customer_deleted`)
 *     that describes consequences, not prerequisites, so subscriptions are not
 *     gated on customer events.
 *
 * We gate on *existence* of the parent rather than resource-version currency:
 * customers in this app are provisioned via the Chargebee API at sign-up (see
 * lib/auth.ts), so a customer can legitimately exist without any
 * webhook-recorded `resource_version` yet — requiring version currency here
 * would requeue those events needlessly.
 */
export async function assertDependencies(event: WebhookEvent): Promise<void> {
  const content = (event.content ?? {}) as Record<string, unknown>;
  const subjects = eventSubjects(event.event_type);
  const { customerIds, subscriptionIds } = collectDependencyRefs(content);

  if (!subjects.customer) {
    for (const customerId of customerIds) {
      if (!(await customerExists(customerId))) {
        throw new RetryableWebhookError(
          `customer ${customerId} not yet in DB for event ${event.id}`,
        );
      }
    }
  }

  if (!subjects.customer && !subjects.subscription) {
    for (const subscriptionId of subscriptionIds) {
      if (!(await subscriptionExists(subscriptionId))) {
        throw new RetryableWebhookError(
          `subscription ${subscriptionId} not yet in DB for event ${event.id}`,
        );
      }
    }
  }
}

// Subscription-create events for which the plugin should have persisted a row.
// Restricted to creation so we never false-retry deletions/cancellations,
// where the expected post-state is absence rather than presence.
const SUBSCRIPTION_CREATE_EVENTS = new Set<string>([
  "subscription_created",
  "subscription_created_with_backdating",
]);

/**
 * Verify-after-process safety net. The plugin swallows hook errors, so after
 * `process()` returns we re-read the entity a create event should have
 * produced. If it's missing the sync silently failed — throw
 * `RetryableWebhookError` so the message retries instead of being lost.
 */
export async function assertProcessed(event: WebhookEvent): Promise<void> {
  const eventType = event.event_type;
  if (!eventType || !SUBSCRIPTION_CREATE_EVENTS.has(eventType)) return;

  const content = (event.content ?? {}) as { subscription?: { id?: string } };
  const subId = content.subscription?.id;
  if (!subId) return;

  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM subscription
      WHERE "chargebeeSubscriptionId" = $1 LIMIT 1`,
    [subId],
  );
  if (rows.length === 0) {
    throw new RetryableWebhookError(
      `subscription ${subId} not persisted after processing event ${event.id}`,
    );
  }
}
