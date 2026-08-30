import {
  features,
  type EntitlementLimits,
  type ResolvedEntitlements,
} from "./features";
import type { EntitlementSubject } from "./subject";
import {
  INPUT_CREDIT_MILLI_PER_TOKEN,
  OUTPUT_CREDIT_MILLI_PER_TOKEN,
  consumeGenerationUsage,
  consumeRateLimit,
  readUsageCounters,
} from "@/lib/usage/counters";
import { isModelAllowed, modelsForTier, type ModelTier } from "@/lib/models";

const MILLI_PER_CREDIT = 1_000;

/** Shown whether the wallet ran dry before the call or during it. */
export const QUOTA_EXHAUSTED =
  "Daily token quota and monthly credits are exhausted";

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
      features.inputTokensDaily.featureId,
      counters.inputUsed,
      limits.inputTokensDaily,
    ),
    threshold(
      features.outputTokensDaily.featureId,
      counters.outputUsed,
      limits.outputTokensDaily,
    ),
    threshold(
      features.creditsMonthly.featureId,
      counters.creditsUsed,
      limits.creditsMonthly,
    ),
    threshold(
      features.apiRatePerMinute.featureId,
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
        featureId: features.inputTokensDaily.featureId,
        used: counters.inputUsed,
        limit: jsonLimit(limits.inputTokensDaily),
        remaining: remaining(counters.inputUsed, limits.inputTokensDaily),
      },
      outputTokensDaily: {
        featureId: features.outputTokensDaily.featureId,
        used: counters.outputUsed,
        limit: jsonLimit(limits.outputTokensDaily),
        remaining: remaining(counters.outputUsed, limits.outputTokensDaily),
      },
      creditsMonthly: {
        featureId: features.creditsMonthly.featureId,
        used: counters.creditsUsed,
        limit: jsonLimit(limits.creditsMonthly),
        remaining: remaining(counters.creditsUsed, limits.creditsMonthly),
      },
      apiRatePerMinute: {
        featureId: features.apiRatePerMinute.featureId,
        used: counters.rateUsed,
        limit: jsonLimit(limits.apiRatePerMinute),
        remaining: remaining(counters.rateUsed, limits.apiRatePerMinute),
        windowSeconds: 60,
      },
      models: {
        featureId: features.models.featureId,
        tier: limits.models,
        allowedModels: await modelsForTier(limits.models),
      },
      sso: { featureId: features.sso.featureId, enabled: limits.sso },
      maxSeats: {
        featureId: features.maxSeats.featureId,
        limit: jsonLimit(limits.maxSeats),
      },
    },
    thresholds,
    entitlementsPending: entitlements.pending,
  };
}

/**
 * Output tokens the subscriber can still pay for: the daily allowance that is
 * left, plus whatever the remaining monthly credits can buy beyond it. Input
 * tokens come off the top because they draw on the same credit pool.
 *
 *   budget = (dailyOutputLimit - outputUsed)
 *          + (creditsLeft - inputOverageCost) / OUTPUT_CREDIT_MILLI_PER_TOKEN
 *
 * `Infinity` limits propagate through the arithmetic, so an unlimited plan
 * yields an unlimited budget without a special case.
 */
function outputTokenBudget(
  limits: EntitlementLimits,
  counters: { inputUsed: number; outputUsed: number; creditsUsed: number },
  inputTokens: number,
): number {
  const outputAllowance = Math.max(
    0,
    limits.outputTokensDaily - counters.outputUsed,
  );
  const inputAllowance = Math.max(
    0,
    limits.inputTokensDaily - counters.inputUsed,
  );
  const inputOverage = Math.max(0, inputTokens - inputAllowance);

  const creditsLeftMilli =
    (limits.creditsMonthly - counters.creditsUsed) * MILLI_PER_CREDIT -
    inputOverage * INPUT_CREDIT_MILLI_PER_TOKEN;

  return (
    outputAllowance +
    Math.floor(Math.max(0, creditsLeftMilli) / OUTPUT_CREDIT_MILLI_PER_TOKEN)
  );
}

/**
 * Everything that can be judged before the model runs. Generation is billed by
 * the upstream provider, so an unentitled model, an exhausted rate limit, or an
 * empty wallet has to be rejected here rather than after the invoice is
 * incurred. The returned budget is what the stream is allowed to spend.
 */
export async function admitGeneration(
  subject: EntitlementSubject,
  entitlements: ResolvedEntitlements,
  request: {
    model: string;
    inputTokens: number;
  },
) {
  const limits = entitlements.limits;
  if (!(await isModelAllowed(limits.models, request.model))) {
    throw new EntitlementGateError(
      402,
      "model_not_entitled",
      features.models.featureId,
      `${request.model} is not available on the ${limits.models} model tier`,
    );
  }

  const rate = await consumeRateLimit(subject, limits.apiRatePerMinute);
  if (!rate.allowed) {
    throw new EntitlementGateError(
      429,
      "rate_limited",
      features.apiRatePerMinute.featureId,
      "The subscription API rate limit has been reached",
      rate.retryAfterSeconds,
    );
  }

  const budget = outputTokenBudget(
    limits,
    await readUsageCounters(subject),
    request.inputTokens,
  );
  if (budget < 1) {
    throw new EntitlementGateError(
      402,
      "quota_exceeded",
      features.creditsMonthly.featureId,
      QUOTA_EXHAUSTED,
    );
  }

  return { outputTokenBudget: budget };
}

/**
 * Settles a finished generation: daily token quotas first, and whatever spills
 * past them against monthly credits. Only the provider knows the real output
 * token count, so this cannot move ahead of the call.
 */
export async function meterGeneration(
  subject: EntitlementSubject,
  entitlements: ResolvedEntitlements,
  usage: {
    inputTokens: number;
    outputTokens: number;
  },
) {
  const limits = entitlements.limits;
  const consumed = await consumeGenerationUsage(
    subject,
    {
      inputTokensDaily: limits.inputTokensDaily,
      outputTokensDaily: limits.outputTokensDaily,
      creditsMonthly: limits.creditsMonthly,
    },
    usage,
  );
  if (!consumed.allowed) {
    throw new EntitlementGateError(
      402,
      "quota_exceeded",
      features.creditsMonthly.featureId,
      QUOTA_EXHAUSTED,
    );
  }
  return {
    ...consumed,
    source:
      consumed.creditsConsumed > 0
        ? ("credits" as const)
        : ("plan_quota" as const),
  };
}
