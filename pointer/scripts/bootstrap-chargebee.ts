// Idempotent bootstrap for the Chargebee Product Catalog 2.0.
//
// Reads the canonical catalog from ./catalog.ts and ensures every entity
// exists in the Chargebee site referenced by CHARGEBEE_SITE/CHARGEBEE_API_KEY:
//
//   item family -> features -> items (plans + packs) -> item prices
//     -> item entitlements -> metered features
//
// Re-running converges (already-present resources are updated, never duplicated).
// Metered features are the exception: Chargebee has no update for them, so that
// stage creates what is missing and refuses on drift rather than recreating.
//
// Metered features also require Advanced Usage Based Billing on the site:
// Settings > Configure Chargebee > Billing LogIQ > Metered Billing and Advanced
// Usage Based Billing.
//
// Usage:
//   pnpm bootstrap:chargebee
//
// Loads env from .env.local via Node's --env-file flag (configured in package.json).

import Chargebee from "chargebee";

import {
  creditPacks,
  features,
  itemEntitlements,
  itemFamily,
  meteredFeatures,
  packItemPrices,
  planItemPrices,
  plans,
  type ItemEntitlementSpec,
  type MeteredFeatureSpec,
  type PlanId,
} from "./catalog";

const site = process.env.CHARGEBEE_SITE;
const apiKey = process.env.CHARGEBEE_API_KEY;

if (!site || !apiKey) {
  console.error(
    "[bootstrap] CHARGEBEE_SITE and CHARGEBEE_API_KEY must be set in .env.local",
  );
  process.exit(1);
}

const cb = new Chargebee({ site, apiKey });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CbError = Error & { api_error_code?: string; http_status_code?: number };

function isNotFound(err: unknown): boolean {
  const e = err as CbError;
  return (
    e?.api_error_code === "resource_not_found" || e?.http_status_code === 404
  );
}

async function tryRetrieve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function log(action: "created" | "updated" | "ok", entity: string, id: string) {
  console.log(`[${action}] ${entity} ${id}`);
}

// ---------------------------------------------------------------------------
// Stage 1: Item Family
// ---------------------------------------------------------------------------

async function upsertItemFamily() {
  const existing = await tryRetrieve(() => cb.itemFamily.retrieve(itemFamily.id));
  if (existing) {
    log("ok", "item_family", itemFamily.id);
    return;
  }
  await cb.itemFamily.create({ id: itemFamily.id, name: itemFamily.name });
  log("created", "item_family", itemFamily.id);
}

// ---------------------------------------------------------------------------
// Stage 2: Features
// ---------------------------------------------------------------------------

async function upsertFeatures() {
  for (const spec of features) {
    const existing = await tryRetrieve(() => cb.feature.retrieve(spec.id));

    if (!existing) {
      // `unit` is only valid on quantity features; the SDK accepts it as
      // optional on all types but Chargebee rejects it for switch/custom.
      const { id, name, type, unit, levels, description } = spec;
      await cb.feature.create({
        id,
        name,
        type,
        ...(unit ? { unit } : {}),
        ...(levels ? { levels } : {}),
        ...(description ? { description } : {}),
      });
      log("created", "feature", spec.id);
    } else {
      // Converge name/unit/levels for any local edits to catalog.ts.
      const { name, unit, levels } = spec;
      await cb.feature.update(spec.id, {
        name,
        ...(unit ? { unit } : {}),
        ...(levels ? { levels } : {}),
      });
      log("updated", "feature", spec.id);
    }

    // Features created via API are in `draft` status until activated.
    // Activating an already-active feature is a safe no-op for our purposes
    // (the SDK returns the current resource).
    try {
      await cb.feature.activate(spec.id);
    } catch (err) {
      const e = err as CbError;
      // "invalid_state_for_request" is returned when the feature is already
      // active; treat as success.
      if (e?.api_error_code !== "invalid_state_for_request") throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 3: Items (plans + credit packs)
// ---------------------------------------------------------------------------

async function upsertItems() {
  const allItems = [...plans, ...creditPacks];
  for (const spec of allItems) {
    const existing = await tryRetrieve(() => cb.item.retrieve(spec.id));
    if (existing) {
      log("ok", "item", spec.id);
      continue;
    }
    // Strip our local-only fields before passing to the SDK.
    const {
      id,
      name,
      type,
      item_family_id,
      description,
      external_name,
    } = spec;
    await cb.item.create({
      id,
      name,
      type,
      item_family_id,
      ...(description ? { description } : {}),
      ...(external_name ? { external_name } : {}),
    });
    log("created", "item", spec.id);
  }
}

// ---------------------------------------------------------------------------
// Stage 4: Item Prices
// ---------------------------------------------------------------------------

async function upsertItemPrices() {
  const all = [...planItemPrices(), ...packItemPrices()];
  for (const spec of all) {
    const existing = await tryRetrieve(() => cb.itemPrice.retrieve(spec.id));
    if (existing) {
      log("ok", "item_price", spec.id);
      continue;
    }
    await cb.itemPrice.create(spec);
    log("created", "item_price", spec.id);
  }
}

// ---------------------------------------------------------------------------
// Stage 5: Item Entitlements
// ---------------------------------------------------------------------------

async function upsertItemEntitlements() {
  for (const planId of Object.keys(itemEntitlements) as PlanId[]) {
    const entitlements = itemEntitlements[planId];
    try {
      await cb.itemEntitlement.upsertOrRemoveItemEntitlementsForItem(planId, {
        action: "upsert",
        item_entitlements: entitlements.map((e: ItemEntitlementSpec) => ({
          feature_id: e.feature_id,
          value: e.value,
        })),
      });
    } catch (err) {
      const e = err as CbError & { message?: string };
      // Sites with the legacy "grandfather" entitlements model reject the
      // per-item upsert API; fall back to the generic /entitlements endpoint
      // which works on both modes.
      const isGrandfather =
        e?.api_error_code === "operation_not_supported" ||
        (typeof e?.message === "string" &&
          e.message.includes("grandfather"));
      if (!isGrandfather) throw err;

      await cb.entitlement.create({
        action: "upsert",
        entitlements: entitlements.map((entitlement) => ({
          entity_id: planId,
          entity_type: "plan",
          feature_id: entitlement.feature_id,
          value: entitlement.value,
        })),
      });
    }
    log("updated", "item_entitlements", `${planId} (${entitlements.length})`);
  }
}

// ---------------------------------------------------------------------------
// Stage 6: Metered Features
//
// Unlike every stage above, this one cannot converge. The API offers create /
// archive / reactivate / delete and no update, so a changed `query` can only be
// applied by deleting the meter — which discards its aggregation history. This
// stage therefore creates what is missing and *refuses* on drift.
//
// There is also no retrieve-by-id and no way to choose the id: Chargebee
// derives it from `name` (`API Calls` -> `API-Calls`). Existing meters are
// found by name, and the resulting id is asserted against the catalog so the
// app can reference it statically.
// ---------------------------------------------------------------------------

/** Chargebee echoes queries with its own casing/spacing, so compare loosely. */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function assertExpectedId(spec: MeteredFeatureSpec, actualId: string) {
  if (actualId === spec.expectedId) return;

  throw new Error(
    `metered feature "${spec.name}" resolved to id "${actualId}", but the ` +
      `catalog expects "${spec.expectedId}". Update expectedId in ` +
      `scripts/catalog.ts to "${actualId}".`,
  );
}

async function findMeterByName(name: string) {
  const result = await cb.meter.list({ name: { is: name }, limit: 100 });
  return (
    result.list
      .map((entry) => entry.meter)
      .find((meter) => meter.name === name && meter.status !== "deleted") ??
    null
  );
}

/** The /meters and /metered_features routes 404 until UBB is switched on. */
function assertUsageBillingEnabled(err: unknown): never {
  if (isNotFound(err)) {
    throw new Error(
      "Chargebee returned 404 for the metered feature APIs. Enable Settings > " +
        "Configure Chargebee > Billing LogIQ > Metered Billing and Advanced " +
        "Usage Based Billing on this site, then re-run.",
      { cause: err },
    );
  }
  throw err;
}

async function upsertMeteredFeatures() {
  for (const spec of meteredFeatures) {
    const existing = await findMeterByName(spec.name).catch(
      assertUsageBillingEnabled,
    );

    if (existing) {
      assertExpectedId(spec, existing.id);

      if (normalizeQuery(existing.query ?? "") !== normalizeQuery(spec.query)) {
        throw new Error(
          `metered feature "${spec.name}" has query "${existing.query}" but ` +
            `the catalog declares "${spec.query}". Chargebee cannot update a ` +
            `meter; deleting it would discard its aggregation history. ` +
            `Resolve manually, then re-run.`,
        );
      }

      log("ok", "metered_feature", existing.id);
      continue;
    }

    const created = await cb.meteredFeature
      .create({
        name: spec.name,
        description: spec.description,
        feature_unit: spec.feature_unit,
        query: spec.query,
        column_definitions: spec.column_definitions.map((column) => ({
          column_name: column.column_name,
          data_type: column.data_type,
        })),
      })
      .catch(assertUsageBillingEnabled);

    assertExpectedId(spec, created.meter.id);
    log("created", "metered_feature", created.meter.id);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[bootstrap] target site: ${site}`);
  await upsertItemFamily();
  await upsertFeatures();
  await upsertItems();
  await upsertItemPrices();
  await upsertItemEntitlements();
  await upsertMeteredFeatures();
  console.log("[bootstrap] complete.");
}

main().catch((err) => {
  console.error("[bootstrap] failed:", err);
  process.exit(1);
});
