/**
 * DuckDB + S3 usage metrics adapter.
 *
 * Batches become immutable Parquet objects under a subscriber/day Hive
 * partition. Writes are at-least-once; reads deduplicate on the event id before
 * aggregating so a crash between S3 upload and Redis acknowledgement is safe.
 */

import process from "node:process";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { UsageMetric } from "@/scripts/catalog";
import type { BufferedUsageEvent } from "./events";
import type { UsageBucket, UsageMetricsStore, UsageSeriesQuery } from "./store";

const CREDITS_MILLI_PER_CREDIT = 1_000;
const DEFAULT_PREFIX = "usage";
const DEFAULT_MEMORY_LIMIT = "256MB";
const DEFAULT_THREADS = "2";
const EMPTY_GLOB_ERROR = "No files found that match the pattern";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9/_-]*$/;

const AGGREGATES: Record<UsageMetric, string> = {
	input_tokens: "SUM(input_tokens)",
	output_tokens: "SUM(output_tokens)",
	credits_consumed: `SUM(credits_milli)::DOUBLE / ${CREDITS_MILLI_PER_CREDIT}`,
	generations: "COUNT(*)",
};

export type DuckDBS3StoreConfig = {
	bucket: string;
	prefix: string;
	region: string;
	endpoint?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	memoryLimit: string;
	threads: string;
	extensionDirectory?: string;
};

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} environment variable is required`);
	}

	return value;
}

function configFromEnv(): DuckDBS3StoreConfig {
	return {
		bucket: requireEnv("USAGE_LAKE_BUCKET"),
		prefix: process.env.USAGE_LAKE_PREFIX ?? DEFAULT_PREFIX,
		region: process.env.AWS_REGION ?? "us-east-1",
		endpoint: process.env.USAGE_LAKE_S3_ENDPOINT,
		accessKeyId: process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
		memoryLimit: process.env.USAGE_LAKE_MEMORY_LIMIT ?? DEFAULT_MEMORY_LIMIT,
		threads: process.env.USAGE_LAKE_THREADS ?? DEFAULT_THREADS,
		extensionDirectory: process.env.DUCKDB_EXTENSION_DIRECTORY,
	};
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function validateConfig(config: DuckDBS3StoreConfig): DuckDBS3StoreConfig {
	const prefix = config.prefix.replace(/^\/+|\/+$/g, "");
	if (!SAFE_BUCKET.test(config.bucket)) {
		throw new Error(`Invalid USAGE_LAKE_BUCKET: ${config.bucket}`);
	}
	if (!(prefix && SAFE_PREFIX.test(prefix)) || prefix.includes("//")) {
		throw new Error(`Invalid USAGE_LAKE_PREFIX: ${config.prefix}`);
	}

	return { ...config, prefix };
}

function localSecret(config: DuckDBS3StoreConfig): string {
	if (!config.endpoint) {
		return `CREATE OR REPLACE SECRET usage_lake (
      TYPE s3,
      PROVIDER credential_chain,
      REGION ${sqlString(config.region)}
    )`;
	}
	if (!(config.accessKeyId && config.secretAccessKey)) {
		throw new Error(
			"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required with USAGE_LAKE_S3_ENDPOINT",
		);
	}

	const endpoint = new URL(config.endpoint);
	return `CREATE OR REPLACE SECRET usage_lake (
    TYPE s3,
    KEY_ID ${sqlString(config.accessKeyId)},
    SECRET ${sqlString(config.secretAccessKey)},
    REGION ${sqlString(config.region)},
    ENDPOINT ${sqlString(endpoint.host)},
    URL_STYLE 'path',
    USE_SSL ${endpoint.protocol === "https:"}
  )`;
}

function appendEvent(
	appender: Awaited<ReturnType<DuckDBConnection["createAppender"]>>,
	event: BufferedUsageEvent,
): void {
	const properties = event.properties;

	appender.appendVarchar(event.deduplicationId);
	appender.appendVarchar(event.subscriptionId);
	appender.appendBigInt(BigInt(event.usageTimestamp));
	appender.appendVarchar(properties.model);
	appender.appendInteger(properties.input_tokens);
	appender.appendInteger(properties.output_tokens);
	appender.appendInteger(
		Math.round(properties.credits_consumed * CREDITS_MILLI_PER_CREDIT),
	);
	appender.appendVarchar(properties.usage_source);
	appender.appendVarchar(properties.plan_id);
	appender.endRow();
}

function assertSubscriptionId(subscriptionId: string): void {
	if (!SAFE_ID.test(subscriptionId)) {
		throw new Error(`Invalid subscription identifier: ${subscriptionId}`);
	}
}

export class DuckDBS3UsageMetricsStore implements UsageMetricsStore {
	private readonly config: DuckDBS3StoreConfig;
	private readonly root: string;
	private instance: Promise<DuckDBInstance> | undefined;

	constructor(config: DuckDBS3StoreConfig = configFromEnv()) {
		this.config = validateConfig(config);
		this.root = `s3://${this.config.bucket}/${this.config.prefix}`;
	}

	private getInstance(): Promise<DuckDBInstance> {
		if (!this.instance) {
			this.instance = this.createInstance();
		}

		return this.instance;
	}

	private async createInstance(): Promise<DuckDBInstance> {
		const options: Record<string, string> = {
			memory_limit: this.config.memoryLimit,
			threads: this.config.threads,
		};
		if (this.config.extensionDirectory) {
			options.extension_directory = this.config.extensionDirectory;
		}

		const instance = await DuckDBInstance.create(":memory:", options);
		const connection = await instance.connect();
		try {
			await connection.run(`
        INSTALL aws;
        LOAD aws;
        INSTALL httpfs;
        LOAD httpfs;
        SET TimeZone = 'UTC';
        SET enable_external_file_cache = true;
        ${localSecret(this.config)}
      `);
		} finally {
			connection.closeSync();
		}

		return instance;
	}

	private async connect(): Promise<DuckDBConnection> {
		const connection = await (await this.getInstance()).connect();
		await connection.run(`
      SET TimeZone = 'UTC';
      SET enable_external_file_cache = true
    `);

		return connection;
	}

	async recordBatch(events: BufferedUsageEvent[]): Promise<void> {
		if (!events.length) {
			return;
		}
		for (const event of events) {
			assertSubscriptionId(event.subscriptionId);
		}

		const connection = await this.connect();
		try {
			await connection.run(`
        CREATE TEMP TABLE staged_usage_events (
          deduplication_id VARCHAR NOT NULL,
          subscription_id VARCHAR NOT NULL,
          usage_timestamp_ms BIGINT NOT NULL,
          model VARCHAR NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          credits_milli INTEGER NOT NULL,
          usage_source VARCHAR NOT NULL,
          plan_id VARCHAR NOT NULL
        )
      `);

			const appender = await connection.createAppender("staged_usage_events");
			try {
				for (const event of events) {
					appendEvent(appender, event);
				}
			} finally {
				appender.closeSync();
			}

			await connection.run(`
        COPY (
          SELECT
            deduplication_id,
            subscription_id,
            model,
            input_tokens,
            output_tokens,
            credits_milli,
            usage_source,
            plan_id,
            to_timestamp(usage_timestamp_ms / 1000.0) AS usage_timestamp,
            strftime(to_timestamp(usage_timestamp_ms / 1000.0), '%Y-%m-%d') AS dt
          FROM staged_usage_events
          ORDER BY subscription_id, usage_timestamp_ms
        ) TO ${sqlString(this.root)}
        (
          FORMAT parquet,
          PARTITION_BY (subscription_id, dt),
          APPEND,
          COMPRESSION zstd
        )
      `);
		} finally {
			connection.closeSync();
		}
	}

	async readSeries(query: UsageSeriesQuery): Promise<UsageBucket[]> {
		assertSubscriptionId(query.subscriptionId);
		const path = `${this.root}/subscription_id=${query.subscriptionId}/dt=*/*.parquet`;
		const connection = await this.connect();

		try {
			const reader = await connection.runAndReadAll(
				`WITH deduplicated AS (
           SELECT * EXCLUDE (delivery)
           FROM (
             SELECT *,
                    row_number() OVER (
                      PARTITION BY deduplication_id
                      ORDER BY usage_timestamp
                    ) AS delivery
             FROM read_parquet(
               $path,
               hive_partitioning = true,
               union_by_name = true
             )
             WHERE usage_timestamp >= $from::TIMESTAMPTZ
               AND usage_timestamp <  $to::TIMESTAMPTZ
           )
           WHERE delivery = 1
         ),
         aggregated AS (
           SELECT date_trunc($window, usage_timestamp) AS bucket,
                  ${AGGREGATES[query.metric]} AS value
           FROM deduplicated
           GROUP BY bucket
           ORDER BY bucket
           LIMIT $limit
         )
         SELECT epoch_ms(bucket)::DOUBLE AS bucket_ms,
                value::DOUBLE AS value
         FROM aggregated`,
				{
					path,
					from: query.from.toISOString(),
					to: query.to.toISOString(),
					window: query.window,
					limit: query.limit,
				},
			);

			return reader.getRowObjectsJS().map((row) => ({
				from: new Date(Number(row.bucket_ms)),
				value: Number(row.value),
			}));
		} catch (error) {
			if (error instanceof Error && error.message.includes(EMPTY_GLOB_ERROR)) {
				return [];
			}

			throw error;
		} finally {
			connection.closeSync();
		}
	}
}
