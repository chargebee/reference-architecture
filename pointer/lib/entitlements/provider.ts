import { createRedisEntitlementsCache } from "@chargebee/entitlements/cache";
import { ChargebeeEntitlements } from "@chargebee/entitlements/server";

import { emit } from "@/lib/events/emit";
import { getRedis } from "@/lib/redis";
import { chargebeeClient } from "@/plugins/chargebee-plugin";

import { PostgresEntitlementsStore } from "./postgres-store";

const CACHE_NAMESPACE = "pointer:entitlements:v1";
const CACHE_TTL_MS =
  Number(process.env.ENTITLEMENTS_CACHE_TTL_SECONDS ?? "300") * 1_000;
const SNAPSHOT_TTL_MS =
  Number(process.env.ENTITLEMENTS_SNAPSHOT_TTL_SECONDS ?? "86400") * 1_000;

/**
 * Entitlement lookups walk Redis, then the PostgreSQL mirror, then Chargebee.
 * A request never waits on Chargebee: a subscription with no local snapshot
 * yet resolves to free-tier defaults while the refresh runs in the background.
 *
 * This client owns snapshot and cache logic. Features are declared against it
 * in `features.ts`; webhook-driven syncs call it directly.
 */
export const entitlements = new ChargebeeEntitlements({
  chargebeeClient,
  // The cache TTL bounds how long Redis may lag PostgreSQL: once it lapses the
  // next lookup reads the mirror again, even if no webhook has arrived.
  cache: createRedisEntitlementsCache(getRedis(), { ttlMs: CACHE_TTL_MS }),
  durableStore: new PostgresEntitlementsStore(),
  snapshotTtlMs: SNAPSHOT_TTL_MS,
  refreshOnMiss: "background",
  advanced: { cacheNamespace: CACHE_NAMESPACE },
  onSnapshotRefreshed: ({ target, snapshot, trigger }) => {
    // Worker, checkout, and reconciliation syncs emit their own event with the
    // triggering Chargebee event attached; this covers request-path refreshes.
    if (trigger !== "request" || !target.subscriptionId) return;
    void emit(
      "chargebee.entitlements_synced",
      {
        subscription_id: target.subscriptionId,
        feature_count: Object.keys(snapshot.entitlements).length,
        generated_at: snapshot.generatedAt,
        trigger: "request",
      },
      { source: "app" },
    );
  },
  onError: (error, { operation, target }) => {
    console.error(`[entitlements] ${operation} failed`, target, error);
  },
});
