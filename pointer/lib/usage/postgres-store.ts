/**
 * PostgreSQL usage metrics adapter.
 *
 * The unique index makes replayed Redis batches no-ops. Range predicates use
 * the partition key and the leading subscription/timestamp index columns.
 */

import { getPool } from "@/lib/db";
import type { UsageMetric } from "@/scripts/catalog";

import type { BufferedUsageEvent } from "./events";
import type { UsageBucket, UsageMetricsStore, UsageSeriesQuery } from "./store";

const CREDITS_MILLI_PER_CREDIT = 1_000;

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

const AGGREGATES: Record<UsageMetric, string> = {
	input_tokens: `SUM("inputTokens")`,
	output_tokens: `SUM("outputTokens")`,
	credits_consumed: `SUM("creditsMilli")::numeric / ${CREDITS_MILLI_PER_CREDIT}`,
	generations: "COUNT(*)",
};

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

function placeholders(count: number): string {
	const tuples: string[] = [];
	for (let row = 0; row < count; row += 1) {
		const start = row * COLUMNS.length;
		const slots = COLUMNS.map((_, column) => `$${start + column + 1}`);
		tuples.push(`(${slots.join(", ")})`);
	}

	return tuples.join(", ");
}

export class PostgresUsageMetricsStore implements UsageMetricsStore {
	async recordBatch(events: BufferedUsageEvent[]): Promise<void> {
		if (!events.length) {
			return;
		}

		const pool = await getPool();
		await pool.query(
			`INSERT INTO usage_event (${COLUMNS.map((name) => `"${name}"`).join(", ")})
           VALUES ${placeholders(events.length)}
      ON CONFLICT ("subscriptionId", "usageTimestamp", "deduplicationId")
      DO NOTHING`,
			events.flatMap(valuesFor),
		);
	}

	async readSeries(query: UsageSeriesQuery): Promise<UsageBucket[]> {
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

		return result.rows.map((row) => ({
			from: row.bucket,
			value: Number(row.value),
		}));
	}
}
