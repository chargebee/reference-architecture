// Canonical Chargebee Product Catalog 2.0 definition for this app.
// Mirrors docs/07-product-and-entitlements.md §4 (catalog) and §3.1 (limits).
// Edit this file in one place; both the bootstrap script and the Better-Auth
// plugin subscription block consume it.

import type { Feature, Item, ItemPrice } from "chargebee";

export const itemFamily = {
  id: "ai-product",
  name: "AI Product",
} as const;

// ---------------------------------------------------------------------------
// Features (Chargebee `Feature` objects)
// ---------------------------------------------------------------------------

type FeatureSpec = Feature.CreateInputParam & { id: string };

export const features: FeatureSpec[] = [
  {
    id: "f_sso",
    name: "SSO",
    type: "switch",
  },
  {
    id: "f_input_tokens_daily",
    name: "Daily input tokens",
    type: "quantity",
    unit: "token",
    levels: [
      { value: "50000", level: 0 },
      { value: "1000000", level: 1 },
      { value: "10000000", level: 2 },
      { value: "5000000", level: 3 },
      { is_unlimited: true, level: 4 },
    ],
  },
  {
    id: "f_output_tokens_daily",
    name: "Daily output tokens",
    type: "quantity",
    unit: "token",
    levels: [
      { value: "10000", level: 0 },
      { value: "200000", level: 1 },
      { value: "2000000", level: 2 },
      { value: "1000000", level: 3 },
      { is_unlimited: true, level: 4 },
    ],
  },
  {
    id: "f_credits_monthly",
    name: "Monthly credits",
    type: "quantity",
    unit: "credit",
    levels: [
      { value: "0", level: 0 },
      { value: "500", level: 1 },
      { value: "5000", level: 2 },
      { value: "2000", level: 3 },
      { is_unlimited: true, level: 4 },
    ],
  },
  {
    id: "f_api_rate_per_minute",
    name: "API requests per minute",
    type: "quantity",
    unit: "request",
    levels: [
      { value: "30", level: 0 },
      { value: "300", level: 1 },
      { value: "1000", level: 2 },
      { value: "500", level: 3 },
      { value: "5000", level: 4 },
    ],
  },
  {
    id: "f_max_seats",
    name: "Max seats",
    type: "quantity",
    unit: "seat",
    levels: [
      { value: "1", level: 0 },
      { value: "100", level: 1 },
      { is_unlimited: true, level: 2 },
    ],
  },
  {
    id: "f_models",
    name: "Available models",
    type: "custom",
    levels: [
      { value: "basic", level: 0 },
      { value: "advanced", level: 1 },
      { value: "premium", level: 2 },
      { value: "enterprise", level: 3 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Items (Plans + Credit Packs)
// ---------------------------------------------------------------------------

export type PlanId =
  | "plan-free"
  | "plan-pro"
  | "plan-max"
  | "plan-team"
  | "plan-enterprise";

export type CreditPackId =
  | "pack-credits-1k"
  | "pack-credits-10k"
  | "pack-credits-100k";

type PlanItem = Item.CreateInputParam & {
  id: PlanId;
  type: "plan";
  /** Monthly price in the smallest currency unit (USD cents). */
  priceUSDMonthlyCents: number;
  /** When true, the USD-Monthly item-price uses pricing_model = per_unit. */
  perUnit?: boolean;
  /** When true, the item-price has a $0 placeholder; real pricing is negotiated per-contract. */
  custom?: boolean;
};

type CreditPackItem = Item.CreateInputParam & {
  id: CreditPackId;
  type: "charge";
  /** One-time price in the smallest currency unit (USD cents). */
  priceUSDCents: number;
  /** Credits granted when the charge is paid (mapped by app-level credit projector). */
  credits: number;
};

export const plans: PlanItem[] = [
  {
    id: "plan-free",
    name: "Free",
    type: "plan",
    item_family_id: itemFamily.id,
    priceUSDMonthlyCents: 0,
  },
  {
    id: "plan-pro",
    name: "Pro",
    type: "plan",
    item_family_id: itemFamily.id,
    priceUSDMonthlyCents: 2000,
  },
  {
    id: "plan-max",
    name: "Max",
    type: "plan",
    item_family_id: itemFamily.id,
    priceUSDMonthlyCents: 10000,
  },
  {
    id: "plan-team",
    name: "Team",
    type: "plan",
    item_family_id: itemFamily.id,
    priceUSDMonthlyCents: 3000,
    perUnit: true,
  },
  {
    id: "plan-enterprise",
    name: "Enterprise",
    type: "plan",
    item_family_id: itemFamily.id,
    priceUSDMonthlyCents: 0,
    custom: true,
  },
];

export const creditPacks: CreditPackItem[] = [
  {
    id: "pack-credits-1k",
    name: "1,000 credits",
    type: "charge",
    item_family_id: itemFamily.id,
    priceUSDCents: 1000,
    credits: 1000,
  },
  {
    id: "pack-credits-10k",
    name: "10,000 credits",
    type: "charge",
    item_family_id: itemFamily.id,
    priceUSDCents: 8000,
    credits: 10000,
  },
  {
    id: "pack-credits-100k",
    name: "100,000 credits",
    type: "charge",
    item_family_id: itemFamily.id,
    priceUSDCents: 70000,
    credits: 100000,
  },
];

// ---------------------------------------------------------------------------
// Item Prices (USD-Monthly per plan, one-time charges per credit pack)
// ---------------------------------------------------------------------------

export type ItemPriceSpec = ItemPrice.CreateInputParam & { id: string };

export function itemPriceIdFor(planId: PlanId): string {
  return `${planId}-USD-Monthly`;
}

export function itemPriceIdForPack(packId: CreditPackId): string {
  return `${packId}-USD`;
}

export function planItemPrices(): ItemPriceSpec[] {
  return plans.map((plan) => ({
    id: itemPriceIdFor(plan.id),
    name: `${plan.name} (USD Monthly)`,
    item_id: plan.id,
    currency_code: "USD",
    period: 1,
    period_unit: "month",
    pricing_model: plan.perUnit ? "per_unit" : "flat_fee",
    price: plan.priceUSDMonthlyCents,
  }));
}

export function packItemPrices(): ItemPriceSpec[] {
  return creditPacks.map((pack) => ({
    id: itemPriceIdForPack(pack.id),
    name: `${pack.name} (USD)`,
    item_id: pack.id,
    currency_code: "USD",
    pricing_model: "flat_fee",
    price: pack.priceUSDCents,
  }));
}

// ---------------------------------------------------------------------------
// Item Entitlements (per-plan feature values). Mirrors docs/07 §4.6 exactly.
// ---------------------------------------------------------------------------

export type ItemEntitlementSpec = { feature_id: string; value: string };

export const itemEntitlements: Record<PlanId, ItemEntitlementSpec[]> = {
  "plan-free": [
    { feature_id: "f_input_tokens_daily", value: "50000" },
    { feature_id: "f_output_tokens_daily", value: "10000" },
    { feature_id: "f_credits_monthly", value: "0" },
    { feature_id: "f_api_rate_per_minute", value: "30" },
    { feature_id: "f_max_seats", value: "1" },
    { feature_id: "f_sso", value: "false" },
    { feature_id: "f_models", value: "basic" },
  ],
  "plan-pro": [
    { feature_id: "f_input_tokens_daily", value: "1000000" },
    { feature_id: "f_output_tokens_daily", value: "200000" },
    { feature_id: "f_credits_monthly", value: "500" },
    { feature_id: "f_api_rate_per_minute", value: "300" },
    { feature_id: "f_max_seats", value: "1" },
    { feature_id: "f_sso", value: "false" },
    { feature_id: "f_models", value: "advanced" },
  ],
  "plan-max": [
    { feature_id: "f_input_tokens_daily", value: "10000000" },
    { feature_id: "f_output_tokens_daily", value: "2000000" },
    { feature_id: "f_credits_monthly", value: "5000" },
    { feature_id: "f_api_rate_per_minute", value: "1000" },
    { feature_id: "f_max_seats", value: "1" },
    { feature_id: "f_sso", value: "false" },
    { feature_id: "f_models", value: "premium" },
  ],
  // Per-seat values; runtime multiplies pooled metrics by subscription.plan_quantity.
  "plan-team": [
    { feature_id: "f_input_tokens_daily", value: "5000000" },
    { feature_id: "f_output_tokens_daily", value: "1000000" },
    { feature_id: "f_credits_monthly", value: "2000" },
    { feature_id: "f_api_rate_per_minute", value: "500" },
    { feature_id: "f_max_seats", value: "100" },
    { feature_id: "f_sso", value: "true" },
    { feature_id: "f_models", value: "premium" },
  ],
  "plan-enterprise": [
    { feature_id: "f_input_tokens_daily", value: "unlimited" },
    { feature_id: "f_output_tokens_daily", value: "unlimited" },
    { feature_id: "f_credits_monthly", value: "unlimited" },
    { feature_id: "f_api_rate_per_minute", value: "5000" },
    { feature_id: "f_max_seats", value: "unlimited" },
    { feature_id: "f_sso", value: "true" },
    { feature_id: "f_models", value: "enterprise" },
  ],
};

// ---------------------------------------------------------------------------
// Metered features (Chargebee `Meter` objects)
//
// Distinct from the `features` above: those are `quantity`/`switch`/`custom`
// entitlement features carrying the numeric limits the app enforces in Redis.
// A metered feature is a *measurement* — an aggregation query over ingested
// usage-event properties — and its auto-created feature is always `range` with
// only `1`/`unlimited` levels, so it cannot carry a limit. The two coexist.
//
// Ingestion is schemaless, so one event per generation feeds every meter below;
// each one selects the columns it needs from the same payload.
// ---------------------------------------------------------------------------

/** Flat property bag sent as `usage_event.properties`. Keys are meter columns. */
export type UsageEventProperties = {
  generation_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  credits_consumed: number;
  usage_source: string;
  plan_id: string;
};

/**
 * Chargebee data type per property. Keyed by `UsageEventProperties` so a new
 * property cannot be added without declaring how a meter would read it.
 */
export const usageEventColumns: Record<
  keyof UsageEventProperties,
  "number" | "string"
> = {
  generation_id: "string",
  model: "string",
  input_tokens: "number",
  output_tokens: "number",
  credits_consumed: "number",
  usage_source: "string",
  plan_id: "string",
};

/** Stable app-side handle for a meter. The HTTP API speaks these, not Chargebee ids. */
export type UsageMetric =
  | "input_tokens"
  | "output_tokens"
  | "credits_consumed"
  | "generations";

export type MeteredFeatureSpec = {
  metric: UsageMetric;
  /**
   * `POST /metered_features` takes no id — Chargebee derives one from `name`
   * (`API Calls` -> `API-Calls`). Bootstrap asserts the created id matches this
   * so runtime lookups stay static instead of listing meters on every read.
   */
  expectedId: string;
  name: string;
  description: string;
  feature_unit: string;
  query: string;
  column_definitions: Array<{
    column_name: keyof UsageEventProperties;
    data_type: "number" | "string";
  }>;
};

/** Derives column definitions from the schema so a query can't reference an undeclared property. */
function columns(
  ...names: Array<keyof UsageEventProperties>
): MeteredFeatureSpec["column_definitions"] {
  return names.map((column_name) => ({
    column_name,
    data_type: usageEventColumns[column_name],
  }));
}

export const meteredFeatures: MeteredFeatureSpec[] = [
  {
    metric: "input_tokens",
    expectedId: "Input-tokens",
    name: "Input tokens",
    description: "Prompt tokens consumed by the subscription",
    feature_unit: "token",
    query: "SELECT SUM(input_tokens) FROM events",
    column_definitions: columns("input_tokens"),
  },
  {
    metric: "output_tokens",
    expectedId: "Output-tokens",
    name: "Output tokens",
    description: "Completion tokens produced for the subscription",
    feature_unit: "token",
    query: "SELECT SUM(output_tokens) FROM events",
    column_definitions: columns("output_tokens"),
  },
  {
    metric: "credits_consumed",
    expectedId: "Credits-consumed",
    name: "Credits consumed",
    description: "Credits drawn down by overage beyond the daily token quotas",
    feature_unit: "credit",
    query: "SELECT SUM(credits_consumed) FROM events",
    column_definitions: columns("credits_consumed"),
  },
  {
    metric: "generations",
    expectedId: "Generations",
    name: "Generations",
    description: "Completed generation requests",
    feature_unit: "request",
    query: "SELECT COUNT(generation_id) FROM events",
    column_definitions: columns("generation_id"),
  },
];

export function meteredFeatureFor(metric: UsageMetric): MeteredFeatureSpec {
  const spec = meteredFeatures.find((entry) => entry.metric === metric);
  if (!spec) {
    throw new Error(`No metered feature is declared for metric: ${metric}`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Plan limits — DRY shape consumed by the Better-Auth plugin subscription
// block (src/lib/auth.ts) so the app can read `subscription.list()[i].limits`
// without round-tripping to Chargebee for entitlement values.
// ---------------------------------------------------------------------------

export type PlanLimits = {
  inputTokensDaily: number | "unlimited";
  outputTokensDaily: number | "unlimited";
  creditsMonthly: number | "unlimited";
  apiRatePerMinute: number;
  maxSeats: number | "unlimited";
  sso: boolean;
  models: "basic" | "advanced" | "premium" | "enterprise";
};

export const planLimits: Record<PlanId, PlanLimits> = {
  "plan-free": {
    inputTokensDaily: 50_000,
    outputTokensDaily: 10_000,
    creditsMonthly: 0,
    apiRatePerMinute: 30,
    maxSeats: 1,
    sso: false,
    models: "basic",
  },
  "plan-pro": {
    inputTokensDaily: 1_000_000,
    outputTokensDaily: 200_000,
    creditsMonthly: 500,
    apiRatePerMinute: 300,
    maxSeats: 1,
    sso: false,
    models: "advanced",
  },
  "plan-max": {
    inputTokensDaily: 10_000_000,
    outputTokensDaily: 2_000_000,
    creditsMonthly: 5_000,
    apiRatePerMinute: 1_000,
    maxSeats: 1,
    sso: false,
    models: "premium",
  },
  "plan-team": {
    inputTokensDaily: 5_000_000,
    outputTokensDaily: 1_000_000,
    creditsMonthly: 2_000,
    apiRatePerMinute: 500,
    maxSeats: 100,
    sso: true,
    models: "premium",
  },
  "plan-enterprise": {
    inputTokensDaily: "unlimited",
    outputTokensDaily: "unlimited",
    creditsMonthly: "unlimited",
    apiRatePerMinute: 5_000,
    maxSeats: "unlimited",
    sso: true,
    models: "enterprise",
  },
};
