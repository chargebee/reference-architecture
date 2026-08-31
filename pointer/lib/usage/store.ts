/**
 * Postgres driver for the usage archive.
 *
 * Every statement that touches `usage_event` lives here. Callers work with
 * `BufferedUsageEvent` and metric names; they never see a column, a bucket
 * expression, or a partition.
 *
 * # Why Postgres holds the history
 *
 * Chargebee remains the billing system of record, but its API quota is a
 * billing resource, not a reporting one. A subscriber refreshing the usage page
 * would spend it on nothing. Every flushed event is archived here and the
 * history read path is served locally.
 */

import { getPool } from "@/lib/db";
import type { UsageMetric } from "@/scripts/catalog";

import type { BufferedUsageEvent } from "./events";
// Type-only, so the summary <-> store cycle is erased at compile time.
import type { UsageWindow } from "./summary";

/** `credits_consumed` arrives fractional; the column stores exact integers. */
const CREDITS_MILLI_PER_CREDIT = 1_000;

/** Insert order. Kept adjacent to the value projection below so they cannot drift. */
const COLUMNS = [
  "deduplicationId",
  "subscriptionId",
  "usageTimestamp",
  "model",
  "inputTokens",
  "outputTokens",
  "creditsMilli",
  "usageSource",
  "planId",
] as const;

function valuesFor(event: BufferedUsageEvent): unknown[] {
  const properties = event.properties;
  return [
    event.deduplicationId,
    event.subscriptionId,
    new Date(event.usageTimestamp),
    properties.model,
    properties.input_tokens,
    properties.output_tokens,
    Math.round(properties.credits_consumed * CREDITS_MILLI_PER_CREDIT),
    properties.usage_source,
    properties.plan_id,
  ];
}

/** `($1, $2, ...), ($10, $11, ...)` — one tuple per event, one statement. */
function placeholders(count: number): string {
  const tuples: string[] = [];
  for (let row = 0; row < count; row += 1) {
    const start = row * COLUMNS.length;
    const slots = COLUMNS.map((_, column) => `$${start + column + 1}`);
    tuples.push(`(${slots.join(", ")})`);
  }
  return tuples.join(", ");
}

/**
 * Archives a flushed batch. One round trip for the whole batch.
 *
 * `DO NOTHING` on the unique index is what makes the flush loop's at-least-once
 * delivery safe: a batch the previous worker wrote but never acknowledged is
 * replayed here as a no-op. `COPY` would be marginally faster but cannot infer
 * a conflict target, and at one batch a minute the index is worth more than the
 * difference.
 */
export async function recordUsageBatch(
  events: BufferedUsageEvent[],
): Promise<void> {
  if (!events.length) return;

  const pool = await getPool();
  await pool.query(
    `INSERT INTO usage_event (${COLUMNS.map((name) => `"${name}"`).join(", ")})
          VALUES ${placeholders(events.length)}
     ON CONFLICT ("subscriptionId", "usageTimestamp", "deduplicationId")
     DO NOTHING`,
    events.flatMap(valuesFor),
  );
}

/**
 * The aggregate each metric reduces to. A closed map, never interpolated from
 * a request: `UsageMetric` is validated at the route boundary, and only these
 * expressions ever reach the query.
 */
const AGGREGATES: Record<UsageMetric, string> = {
  input_tokens: `SUM("inputTokens")`,
  output_tokens: `SUM("outputTokens")`,
  credits_consumed: `SUM("creditsMilli")::numeric / ${CREDITS_MILLI_PER_CREDIT}`,
  generations: "COUNT(*)",
};

export type UsageSeriesQuery = {
  subscriptionId: string;
  metric: UsageMetric;
  window: UsageWindow;
  /** Inclusive, already snapped to a UTC window boundary by the caller. */
  from: Date;
  /** Exclusive. */
  to: Date;
  /** Bucket ceiling. Ask for one more than you need to detect a trimmed range. */
  limit: number;
};

/** One occupied bucket. Empty spans are absent — `GROUP BY` cannot invent them. */
export type UsageBucket = {
  from: Date;
  value: number;
};

/**
 * Aggregates archived events into time buckets.
 *
 * `date_trunc` is given an explicit `'UTC'` so week and month boundaries do not
 * follow whatever `TimeZone` the server happens to carry. The range predicate
 * on the partition key is what prunes the scan down to the weeks in question,
 * and `("subscriptionId", "usageTimestamp")` leads the only index.
 */
export async function readUsageSeries(
  query: UsageSeriesQuery,
): Promise<UsageBucket[]> {
  const pool = await getPool();
  const result = await pool.query<{ bucket: Date; value: string }>(
    `SELECT date_trunc($1::text, "usageTimestamp", 'UTC') AS bucket,
            ${AGGREGATES[query.metric]} AS value
       FROM usage_event
      WHERE "subscriptionId" = $2
        AND "usageTimestamp" >= $3
        AND "usageTimestamp" <  $4
      GROUP BY bucket
      ORDER BY bucket
      LIMIT $5`,
    [query.window, query.subscriptionId, query.from, query.to, query.limit],
  );

  // SUM and COUNT come back as strings: both widen to bigint or numeric.
  return result.rows.map((row) => ({
    from: row.bucket,
    value: Number(row.value),
  }));
}
