import { OpenFeature, type Client } from "@openfeature/server-sdk";
import { createRedisEntitlementsCache } from "@chargebee/entitlements/cache";
import { ChargebeeEntitlements } from "@chargebee/entitlements/server";
import { ChargebeeEntitlementsProvider } from "@chargebee/openfeature/server";

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
 * Snapshot and cache logic lives on this client; the OpenFeature provider below
 * is only an adapter over it. Webhook-driven syncs call it directly.
 */
export const entitlements = new ChargebeeEntitlements({
  chargebeeClient,
  defaultMode: "subscription",
  // The cache TTL bounds how long Redis may lag PostgreSQL: once it lapses the
  // next lookup reads the mirror again, even if no webhook has arrived.
  cache: createRedisEntitlementsCache(getRedis(), { ttlMs: CACHE_TTL_MS }),
  store: new PostgresEntitlementsStore(),
  snapshotTtlMs: SNAPSHOT_TTL_MS,
  cacheNamespace: CACHE_NAMESPACE,
  refreshOnMiss: "background",
  onSnapshotRefreshed: ({ target, snapshot, trigger }) => {
    // Worker, checkout, and reconciliation syncs emit their own event with the
    // triggering Chargebee event attached; this covers request-path refreshes.
    if (trigger !== "request" || target.mode !== "subscription") return;
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

export const entitlementsProvider = new ChargebeeEntitlementsProvider({
  entitlements,
});

declare global {
  var __pointerEntitlementsClientPromise: Promise<Client> | undefined;
}

let clientPromise: Promise<Client> | undefined;

export function getEntitlementsClient(): Promise<Client> {
  if (globalThis.__pointerEntitlementsClientPromise) {
    return globalThis.__pointerEntitlementsClientPromise;
  }
  if (clientPromise) return clientPromise;

  clientPromise = OpenFeature.setProviderAndWait(entitlementsProvider).then(() =>
    OpenFeature.getClient("pointer-entitlements"),
  );
  if (process.env.NODE_ENV !== "production") {
    globalThis.__pointerEntitlementsClientPromise = clientPromise;
  }
  return clientPromise;
}
