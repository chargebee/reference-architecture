import { FEATURE_IDS, type ResolvedEntitlements } from "./features";
import type { EntitlementSubject } from "./subject";
import {
  consumeGenerationUsage,
  consumeRateLimit,
  readUsageCounters,
} from "@/lib/usage/counters";
import { isModelAllowed, modelsForTier, type ModelTier } from "@/lib/models";

export type GateErrorCode =
  | "model_not_entitled"
  | "rate_limited"
  | "quota_exceeded";

export class EntitlementGateError extends Error {
  constructor(
    readonly status: 402 | 429,
    readonly code: GateErrorCode,
    readonly featureId: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export type LimitValue = number | "unlimited";

function jsonLimit(value: number): LimitValue {
  return Number.isFinite(value) ? value : "unlimited";
}

function remaining(used: number, limit: number): LimitValue {
  return Number.isFinite(limit) ? Math.max(0, limit - used) : "unlimited";
}

function threshold(featureId: string, used: number, limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const percent = Math.floor((used / limit) * 100);
  return percent >= 80 ? { featureId, percent } : null;
}

export type UsageSnapshot = {
  subscriptionId: string;
  planId: string | null;
  period: {
    dailyTokensResetAt: string;
    monthlyCreditsResetAt: string;
  };
  features: {
    inputTokensDaily: {
      featureId: string;
      used: number;
      limit: LimitValue;
      remaining: LimitValue;
    };
    outputTokensDaily: {
      featureId: string;
      used: number;
      limit: LimitValue;
      remaining: LimitValue;
    };
    creditsMonthly: {
      featureId: string;
      used: number;
      limit: LimitValue;
      remaining: LimitValue;
    };
    apiRatePerMinute: {
      featureId: string;
      used: number;
      limit: LimitValue;
      remaining: LimitValue;
      windowSeconds: 60;
    };
    models: {
      featureId: string;
      tier: ModelTier;
      allowedModels: string[];
    };
    sso: { featureId: string; enabled: boolean };
    maxSeats: { featureId: string; limit: LimitValue };
  };
  thresholds: Array<{ featureId: string; percent: number }>;
  /** True while the limits above are the free-tier floor, not the plan's. */
  entitlementsPending: boolean;
};

export async function getUsageSnapshot(
  subject: EntitlementSubject,
  entitlements: ResolvedEntitlements,
): Promise<UsageSnapshot> {
  const limits = entitlements.limits;
  const counters = await readUsageCounters(subject);
  const thresholds = [
    threshold(
      FEATURE_IDS.inputTokensDaily,
      counters.inputUsed,
      limits.inputTokensDaily,
    ),
    threshold(
      FEATURE_IDS.outputTokensDaily,
      counters.outputUsed,
      limits.outputTokensDaily,
    ),
    threshold(
      FEATURE_IDS.creditsMonthly,
      counters.creditsUsed,
      limits.creditsMonthly,
    ),
    threshold(
      FEATURE_IDS.apiRatePerMinute,
      counters.rateUsed,
      limits.apiRatePerMinute,
    ),
  ].filter(
    (entry): entry is { featureId: string; percent: number } => entry !== null,
  );

  return {
    subscriptionId: subject.chargebeeSubscriptionId,
    planId: subject.subscription.planId,
    period: {
      dailyTokensResetAt: counters.dailyResetAt,
      monthlyCreditsResetAt: counters.monthlyResetAt,
    },
    features: {
      inputTokensDaily: {
        featureId: FEATURE_IDS.inputTokensDaily,
        used: counters.inputUsed,
        limit: jsonLimit(limits.inputTokensDaily),
        remaining: remaining(counters.inputUsed, limits.inputTokensDaily),
      },
      outputTokensDaily: {
        featureId: FEATURE_IDS.outputTokensDaily,
        used: counters.outputUsed,
        limit: jsonLimit(limits.outputTokensDaily),
        remaining: remaining(counters.outputUsed, limits.outputTokensDaily),
      },
      creditsMonthly: {
        featureId: FEATURE_IDS.creditsMonthly,
        used: counters.creditsUsed,
        limit: jsonLimit(limits.creditsMonthly),
        remaining: remaining(counters.creditsUsed, limits.creditsMonthly),
      },
      apiRatePerMinute: {
        featureId: FEATURE_IDS.apiRatePerMinute,
        used: counters.rateUsed,
        limit: jsonLimit(limits.apiRatePerMinute),
        remaining: remaining(counters.rateUsed, limits.apiRatePerMinute),
        windowSeconds: 60,
      },
      models: {
        featureId: FEATURE_IDS.models,
        tier: limits.models,
        allowedModels: await modelsForTier(limits.models),
      },
      sso: { featureId: FEATURE_IDS.sso, enabled: limits.sso },
      maxSeats: {
        featureId: FEATURE_IDS.maxSeats,
        limit: jsonLimit(limits.maxSeats),
      },
    },
    thresholds,
    entitlementsPending: entitlements.pending,
  };
}

export async function enforceGeneration(
  subject: EntitlementSubject,
  entitlements: ResolvedEntitlements,
  request: {
    model: string;
    inputTokens: number;
    outputTokens: number;
  },
) {
  const limits = entitlements.limits;
  if (!(await isModelAllowed(limits.models, request.model))) {
    throw new EntitlementGateError(
      402,
      "model_not_entitled",
      FEATURE_IDS.models,
      `${request.model} is not available on the ${limits.models} model tier`,
    );
  }

  const rate = await consumeRateLimit(subject, limits.apiRatePerMinute);
  if (!rate.allowed) {
    throw new EntitlementGateError(
      429,
      "rate_limited",
      FEATURE_IDS.apiRatePerMinute,
      "The subscription API rate limit has been reached",
      rate.retryAfterSeconds,
    );
  }

  const usage = await consumeGenerationUsage(
    subject,
    {
      inputTokensDaily: limits.inputTokensDaily,
      outputTokensDaily: limits.outputTokensDaily,
      creditsMonthly: limits.creditsMonthly,
    },
    {
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
    },
  );
  if (!usage.allowed) {
    throw new EntitlementGateError(
      402,
      "quota_exceeded",
      FEATURE_IDS.creditsMonthly,
      "Daily token quota and monthly credits are exhausted",
    );
  }
  return {
    ...usage,
    source: usage.creditsConsumed > 0 ? ("credits" as const) : ("plan_quota" as const),
  };
}
