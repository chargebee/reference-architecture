import process from "node:process";
import type { UsageMetric } from "@/scripts/catalog";
import type { BufferedUsageEvent } from "./events";

export type UsageWindow = "hour" | "day" | "week" | "month";

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

/** Storage port shared by the PostgreSQL and S3 adapters. */
export interface UsageMetricsStore {
	recordBatch(events: BufferedUsageEvent[]): Promise<void>;
	readSeries(query: UsageSeriesQuery): Promise<UsageBucket[]>;
}

export enum UsageStoreType {
	Postgres = "postgres",
	S3 = "s3",
}

export function usageStoreType(value = process.env.USAGE_METRICS_STORE) {
	if (!value || value === UsageStoreType.Postgres) {
		return UsageStoreType.Postgres;
	}
	if (value === UsageStoreType.S3) {
		return UsageStoreType.S3;
	}

	throw new Error(
		`USAGE_METRICS_STORE must be "${UsageStoreType.Postgres}" or "${UsageStoreType.S3}", received "${value}"`,
	);
}

let cached: Promise<UsageMetricsStore> | undefined;

/** Lazily loads only the configured adapter and its infrastructure dependencies. */
export function getUsageMetricsStore(): Promise<UsageMetricsStore> {
	if (cached) {
		return cached;
	}

	cached =
		usageStoreType() === UsageStoreType.S3
			? import("./duckdb-s3-store").then(
					({ DuckDBS3UsageMetricsStore }) => new DuckDBS3UsageMetricsStore(),
				)
			: import("./postgres-store").then(
					({ PostgresUsageMetricsStore }) => new PostgresUsageMetricsStore(),
				);

	return cached;
}
