import type { EntitlementResolution, Feature } from "@chargebee/entitlements";

import { isModelTier, type ModelTier } from "@/lib/models";
import { planLimits } from "@/scripts/catalog";

import { entitlements } from "./provider";
import type { EntitlementSubject } from "./subject";

function unlimitedToInfinity(value: number | "unlimited"): number {
  return value === "unlimited" ? Number.POSITIVE_INFINITY : value;
}

const free = planLimits["plan-free"];

/**
 * Every entitlement this app enforces, declared once.
 *
 * The default value does double duty. It is the floor applied before a
 * snapshot exists — everyone is entitled to at least the free plan, so a
 * pending snapshot degrades to it instead of failing — and its type is what
 * the entitlement resolves to. Chargebee stores every value as a string, so
 * `Feature<number>` is what turns `"300"` into `300` and `"unlimited"` into
 * `Number.POSITIVE_INFINITY`.
 *
 * Features are created from the client, so each one is bound to it and there
 * is no global to register before the first lookup.
 */
export const features = {
  inputTokensDaily: entitlements.feature(
    "f_input_tokens_daily",
    unlimitedToInfinity(free.inputTokensDaily),
  ),
  outputTokensDaily: entitlements.feature(
    "f_output_tokens_daily",
    unlimitedToInfinity(free.outputTokensDaily),
  ),
  creditsMonthly: entitlements.feature(
    "f_credits_monthly",
    unlimitedToInfinity(free.creditsMonthly),
  ),
  apiRatePerMinute: entitlements.feature(
    "f_api_rate_per_minute",
    free.apiRatePerMinute,
  ),
  maxSeats: entitlements.feature(
    "f_max_seats",
    unlimitedToInfinity(free.maxSeats),
  ),
  sso: entitlements.feature("f_sso", free.sso),
  models: entitlements.feature<ModelTier>("f_models", free.models),
};

type FeatureCatalog = typeof features;

/**
 * Derived from the catalog rather than declared alongside it, so a feature
 * cannot be added, removed, or retyped without the limits following.
 */
export type EntitlementLimits = {
  [K in keyof FeatureCatalog]: FeatureCatalog[K] extends Feature<infer T>
    ? T
    : never;
};

/** Every shape a catalog feature can resolve to. */
type LimitValue = EntitlementLimits[keyof EntitlementLimits];

export type ResolvedEntitlements = {
  limits: EntitlementLimits;
  /**
   * True while Chargebee entitlements are still loading for this subscription.
   * The limits are then the free-tier floor rather than the subscriber's plan.
   */
  pending: boolean;
};

export class EntitlementEvaluationError extends Error {
  constructor(
    readonly featureId: string,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A feature the plan does not grant resolves to the caller default, as does a
 * snapshot that has not loaded yet. Anything else — a malformed value, a broken
 * evaluation target — is a configuration fault and must not silently pass.
 */
function read<T>(featureId: string, resolution: EntitlementResolution<T>) {
  if (resolution.errorCode && resolution.errorCode !== "FLAG_NOT_FOUND") {
    throw new EntitlementEvaluationError(
      featureId,
      resolution.errorCode,
      resolution.errorMessage ?? `Unable to evaluate ${featureId}`,
    );
  }
  return { value: resolution.value, pending: resolution.reason === "STALE" };
}

/**
 * Resolves every entitlement this app enforces. Checks run serially so the
 * first one to read the PostgreSQL store warms Redis for the rest of the
 * request.
 */
export async function resolveEntitlements(
  subject: EntitlementSubject,
): Promise<ResolvedEntitlements> {
  const target = { subscriptionId: subject.chargebeeSubscriptionId };
  const limits: Record<string, LimitValue> = {};
  let pending = false;

  for (const [name, feature] of Object.entries(features)) {
    const resolved = read<LimitValue>(
      feature.featureId,
      await feature.getDetails(target),
    );
    limits[name] = resolved.value;
    pending ||= resolved.pending;
  }

  // `Feature<ModelTier>` asserts the type; Chargebee can still return a tier
  // this build has never heard of, and that must not reach the model gate.
  if (!isModelTier(String(limits.models))) {
    throw new EntitlementEvaluationError(
      features.models.featureId,
      "PARSE_ERROR",
      `Unknown model entitlement tier: ${String(limits.models)}`,
    );
  }

  return { limits: limits as EntitlementLimits, pending };
}
