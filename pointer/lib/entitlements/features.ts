import type { EvaluationContext } from "@openfeature/server-sdk";

import { isModelTier, type ModelTier } from "@/lib/models";
import { planLimits } from "@/scripts/catalog";

import { getEntitlementsClient } from "./provider";
import type { EntitlementSubject } from "./subject";

export const FEATURE_IDS = {
  sso: "f_sso",
  inputTokensDaily: "f_input_tokens_daily",
  outputTokensDaily: "f_output_tokens_daily",
  creditsMonthly: "f_credits_monthly",
  apiRatePerMinute: "f_api_rate_per_minute",
  maxSeats: "f_max_seats",
  models: "f_models",
} as const;

export type EntitlementLimits = {
  inputTokensDaily: number;
  outputTokensDaily: number;
  creditsMonthly: number;
  apiRatePerMinute: number;
  maxSeats: number;
  sso: boolean;
  models: ModelTier;
};

export type ResolvedEntitlements = {
  limits: EntitlementLimits;
  /**
   * True while Chargebee entitlements are still loading for this subscription.
   * The limits are then the free-tier floor rather than the subscriber's plan.
   */
  pending: boolean;
};

function unlimitedToInfinity(value: number | "unlimited"): number {
  return value === "unlimited" ? Number.POSITIVE_INFINITY : value;
}

/**
 * The floor applied before a snapshot exists. Everyone is entitled to at least
 * the free plan, so a pending snapshot degrades to it instead of failing.
 */
const FREE_TIER: EntitlementLimits = {
  inputTokensDaily: unlimitedToInfinity(planLimits["plan-free"].inputTokensDaily),
  outputTokensDaily: unlimitedToInfinity(
    planLimits["plan-free"].outputTokensDaily,
  ),
  creditsMonthly: unlimitedToInfinity(planLimits["plan-free"].creditsMonthly),
  apiRatePerMinute: planLimits["plan-free"].apiRatePerMinute,
  maxSeats: unlimitedToInfinity(planLimits["plan-free"].maxSeats),
  sso: planLimits["plan-free"].sso,
  models: planLimits["plan-free"].models,
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

function contextFor(subject: EntitlementSubject): EvaluationContext {
  return {
    targetingKey: subject.referenceId,
    chargebeeEvaluationMode: "subscription",
    chargebeeSubscriptionId: subject.chargebeeSubscriptionId,
  };
}

type Details<T> = {
  value: T;
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
};

/**
 * A feature the plan does not grant resolves to the caller default, as does a
 * snapshot that has not loaded yet. Anything else — a malformed value, a broken
 * evaluation context — is a configuration fault and must not silently pass.
 */
function readDetails<T>(featureId: string, details: Details<T>) {
  if (details.errorCode && details.errorCode !== "FLAG_NOT_FOUND") {
    throw new EntitlementEvaluationError(
      featureId,
      details.errorCode,
      details.errorMessage ?? `Unable to evaluate ${featureId}`,
    );
  }
  return { value: details.value, pending: details.reason === "STALE" };
}

export async function numberEntitlement(
  subject: EntitlementSubject,
  featureId: string,
  defaultValue: number,
) {
  const client = await getEntitlementsClient();
  return readDetails(
    featureId,
    await client.getNumberDetails(featureId, defaultValue, contextFor(subject)),
  );
}

export async function stringEntitlement(
  subject: EntitlementSubject,
  featureId: string,
  defaultValue: string,
) {
  const client = await getEntitlementsClient();
  return readDetails(
    featureId,
    await client.getStringDetails(featureId, defaultValue, contextFor(subject)),
  );
}

export async function booleanEntitlement(
  subject: EntitlementSubject,
  featureId: string,
  defaultValue: boolean,
) {
  const client = await getEntitlementsClient();
  return readDetails(
    featureId,
    await client.getBooleanDetails(featureId, defaultValue, contextFor(subject)),
  );
}

/**
 * Resolves every entitlement this app enforces. Checks run serially so the
 * first one to read the PostgreSQL store warms Redis for the rest of the
 * request.
 */
export async function resolveEntitlements(
  subject: EntitlementSubject,
): Promise<ResolvedEntitlements> {
  const inputTokensDaily = await numberEntitlement(
    subject,
    FEATURE_IDS.inputTokensDaily,
    FREE_TIER.inputTokensDaily,
  );
  const outputTokensDaily = await numberEntitlement(
    subject,
    FEATURE_IDS.outputTokensDaily,
    FREE_TIER.outputTokensDaily,
  );
  const creditsMonthly = await numberEntitlement(
    subject,
    FEATURE_IDS.creditsMonthly,
    FREE_TIER.creditsMonthly,
  );
  const apiRatePerMinute = await numberEntitlement(
    subject,
    FEATURE_IDS.apiRatePerMinute,
    FREE_TIER.apiRatePerMinute,
  );
  const maxSeats = await numberEntitlement(
    subject,
    FEATURE_IDS.maxSeats,
    FREE_TIER.maxSeats,
  );
  const sso = await booleanEntitlement(subject, FEATURE_IDS.sso, FREE_TIER.sso);
  const models = await stringEntitlement(
    subject,
    FEATURE_IDS.models,
    FREE_TIER.models,
  );
  if (!isModelTier(models.value)) {
    throw new EntitlementEvaluationError(
      FEATURE_IDS.models,
      "PARSE_ERROR",
      `Unknown model entitlement tier: ${models.value}`,
    );
  }

  const resolved = [
    inputTokensDaily,
    outputTokensDaily,
    creditsMonthly,
    apiRatePerMinute,
    maxSeats,
    sso,
    models,
  ];
  return {
    limits: {
      inputTokensDaily: inputTokensDaily.value,
      outputTokensDaily: outputTokensDaily.value,
      creditsMonthly: creditsMonthly.value,
      apiRatePerMinute: apiRatePerMinute.value,
      maxSeats: maxSeats.value,
      sso: sso.value,
      models: models.value,
    },
    pending: resolved.some((entitlement) => entitlement.pending),
  };
}
