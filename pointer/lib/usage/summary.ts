/**
 * Chargebee usage-summary driver: buffered usage read back as a time series.
 *
 * This is a reporting surface, never an enforcement one. The endpoint is
 * documented as eventually consistent, and events reach it a batch behind the
 * flush interval, so quota decisions stay with the Redis counters in
 * `counters.ts`. What this gives the subscriber is history, which the counters
 * cannot: they only ever hold the current period.
 *
 * # Window alignment
 *
 * Chargebee buckets from `timeframe_start` forward, not on calendar
 * boundaries. Asking for `day` at 14:20 yields rolling 14:20-to-14:20 windows,
 * which is not what a chart labelled "daily" means, so the start is snapped to
 * a UTC boundary before the call.
 */

import { meteredFeatureFor, type UsageMetric } from "@/scripts/catalog";
import { chargebeeClient } from "@/plugins/chargebee-plugin";

export type UsageWindow = "hour" | "day" | "week" | "month";

const WINDOWS: UsageWindow[] = ["hour", "day", "week", "month"];

/** Chargebee's per-page ceiling for usage summary entries. */
const PAGE_SIZE = 100;
/** Bounds paging on an over-broad range, e.g. hourly windows across a year. */
const MAX_WINDOWS = 1_000;

export function isUsageWindow(value: string): value is UsageWindow {
  return (WINDOWS as string[]).includes(value);
}

/**
 * Floors a timestamp to the start of its UTC calendar window. Weeks start
 * Monday, matching ISO-8601.
 */
export function snapToWindow(date: Date, window: UsageWindow): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  if (window === "hour") {
    return new Date(Date.UTC(year, month, day, date.getUTCHours()));
  }
  if (window === "day") {
    return new Date(Date.UTC(year, month, day));
  }
  if (window === "week") {
    // getUTCDay() is 0 for Sunday; rotate so Monday is 0.
    const offset = (date.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(year, month, day - offset));
  }
  return new Date(Date.UTC(year, month, 1));
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

export type UsageSummaryPoint = {
  /** Inclusive start of the bucket. */
  from: string;
  /** Exclusive end of the bucket. */
  to: string;
  value: number;
};

export type UsageSummarySeries = {
  metric: UsageMetric;
  featureId: string;
  unit: string;
  window: UsageWindow;
  from: string;
  to: string;
  points: UsageSummaryPoint[];
  /** True when the range held more buckets than one response may carry. */
  truncated: boolean;
};

export type UsageSummaryQuery = {
  subscriptionId: string;
  metric: UsageMetric;
  window: UsageWindow;
  from: Date;
  to: Date;
};

export async function fetchUsageSummary(
  query: UsageSummaryQuery,
): Promise<UsageSummarySeries> {
  const feature = meteredFeatureFor(query.metric);
  const from = snapToWindow(query.from, query.window);

  const points: UsageSummaryPoint[] = [];
  let offset: string | undefined;
  let truncated = false;

  do {
    const page = await chargebeeClient.usageSummary.retrieveUsageSummaryForSubscription(
      query.subscriptionId,
      {
        feature_id: feature.expectedId,
        window_size: query.window,
        timeframe_start: toEpochSeconds(from),
        timeframe_end: toEpochSeconds(query.to),
        limit: PAGE_SIZE,
        ...(offset ? { offset } : {}),
      },
    );

    for (const entry of page.list) {
      points.push({
        from: new Date(entry.usage_summary.aggregated_from * 1_000).toISOString(),
        to: new Date(entry.usage_summary.aggregated_to * 1_000).toISOString(),
        // Typed as a string by the SDK, returned as a number by the API.
        value: Number(entry.usage_summary.aggregated_value ?? 0),
      });
    }

    offset = page.next_offset;
    if (offset && points.length >= MAX_WINDOWS) {
      truncated = true;
      break;
    }
  } while (offset);

  return {
    metric: query.metric,
    featureId: feature.expectedId,
    unit: feature.feature_unit,
    window: query.window,
    from: from.toISOString(),
    to: query.to.toISOString(),
    points,
    truncated,
  };
}
