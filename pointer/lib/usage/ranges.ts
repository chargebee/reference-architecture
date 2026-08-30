/**
 * Reporting ranges for the usage page.
 *
 * Chargebee's usage summary takes a window size and a timeframe; a subscriber
 * thinks in "the last 24 hours" or "this billing period". This translates one
 * into the other, and scales the enforced limits to the same span so a range
 * total has something to be read against.
 *
 * The scaling is a pace line, not a ceiling. Only two combinations land on a
 * real enforcement window: `24h` against the daily token quotas, and `period`
 * against the monthly credits.
 */

import type { UsageMetric } from "@/scripts/catalog";

import type { UsageWindow } from "./summary";

export type UsageRangeKey = "24h" | "7d" | "30d" | "period";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Stands in for the billing period when the local mirror has no dates yet. */
const ASSUMED_PERIOD_DAYS = 30;

type RangeSpec = {
  key: UsageRangeKey;
  label: string;
  window: UsageWindow;
  /** Null spans the billing period, whose length only the subscription knows. */
  days: number | null;
};

/** Declaration order is tab order. */
export const usageRanges: RangeSpec[] = [
  { key: "24h", label: "24 hours", window: "hour", days: 1 },
  { key: "7d", label: "7 days", window: "day", days: 7 },
  { key: "30d", label: "30 days", window: "day", days: 30 },
  { key: "period", label: "Billing period", window: "day", days: null },
];

export function isUsageRange(value: string): value is UsageRangeKey {
  return usageRanges.some((range) => range.key === value);
}

/** The limits a metered feature can be read against. `Infinity` is unlimited. */
export type QuotaLimits = {
  inputTokensDaily: number;
  outputTokensDaily: number;
  creditsMonthly: number;
};

export type SubscriptionPeriod = {
  periodStart: Date | null;
  periodEnd: Date | null;
};

export type UsageRange = {
  key: UsageRangeKey;
  label: string;
  window: UsageWindow;
  from: Date;
  to: Date;
  /** The enforced limit over this span, or null where the metric has none. */
  allowances: Record<UsageMetric, number | null>;
};

function specFor(key: UsageRangeKey): RangeSpec {
  const spec = usageRanges.find((range) => range.key === key);
  if (!spec) throw new Error(`No usage range is declared for: ${key}`);
  return spec;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

/**
 * Length of the current billing period, used to prorate the monthly credit
 * limit down to a shorter range.
 */
function periodDays(period: SubscriptionPeriod): number {
  const { periodStart, periodEnd } = period;
  if (!periodStart || !periodEnd) return ASSUMED_PERIOD_DAYS;

  const span = daysBetween(periodStart, periodEnd);
  return span > 0 ? span : ASSUMED_PERIOD_DAYS;
}

function scale(limit: number, factor: number): number {
  if (!Number.isFinite(limit)) return Number.POSITIVE_INFINITY;
  return Math.round(limit * factor);
}

export function resolveUsageRange(
  key: UsageRangeKey,
  period: SubscriptionPeriod,
  limits: QuotaLimits,
  now = new Date(),
): UsageRange {
  const spec = specFor(key);

  // A period that has not started, or is missing entirely, would otherwise
  // produce an empty or backwards timeframe.
  const start = period.periodStart;
  const usableStart = start && start.getTime() < now.getTime() ? start : null;

  const from =
    spec.days === null && usableStart
      ? usableStart
      : new Date(now.getTime() - (spec.days ?? ASSUMED_PERIOD_DAYS) * MS_PER_DAY);

  const days = daysBetween(from, now);

  return {
    key,
    label: spec.label,
    window: spec.window,
    from,
    to: now,
    allowances: {
      input_tokens: scale(limits.inputTokensDaily, days),
      output_tokens: scale(limits.outputTokensDaily, days),
      credits_consumed: scale(limits.creditsMonthly, days / periodDays(period)),
      generations: null,
    },
  };
}
