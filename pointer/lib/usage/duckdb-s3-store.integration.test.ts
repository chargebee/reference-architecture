import process from "node:process";
import { describe, expect, it } from "vitest";
import { DuckDBS3UsageMetricsStore } from "./duckdb-s3-store";
import type { BufferedUsageEvent } from "./events";

const s3Tests = process.env.RUN_S3_TESTS === "1" ? describe : describe.skip;

s3Tests("DuckDB S3 usage metrics store", () => {
	const subscriptionId = `test-${process.pid}-${Date.now()}`;
	const store = new DuckDBS3UsageMetricsStore({
		bucket: process.env.USAGE_LAKE_BUCKET ?? "pointer-usage-local",
		prefix: `integration/${subscriptionId}`,
		region: process.env.AWS_REGION ?? "us-east-1",
		endpoint: process.env.USAGE_LAKE_S3_ENDPOINT ?? "http://localhost:4566",
		accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
		memoryLimit: "256MB",
		threads: "2",
	});

	function event(
		id: string,
		at: string,
		inputTokens: number,
	): BufferedUsageEvent {
		return {
			deduplicationId: `${subscriptionId}-${id}`,
			subscriptionId,
			usageTimestamp: new Date(at).getTime(),
			properties: {
				generation_id: `${subscriptionId}-${id}`,
				model: "openai/gpt-4o-mini",
				input_tokens: inputTokens,
				output_tokens: inputTokens * 2,
				credits_consumed: 0.25,
				usage_source: "plan_quota",
				plan_id: "plan-pro",
			},
		};
	}

	it("writes Parquet and deduplicates replayed batches on read", async () => {
		const batch = [
			event("a", "2026-09-20T01:00:00.000Z", 10),
			event("b", "2026-09-20T05:00:00.000Z", 20),
			event("c", "2026-09-21T01:00:00.000Z", 30),
		];
		await store.recordBatch(batch);
		await store.recordBatch(batch);

		const result = await store.readSeries({
			subscriptionId,
			metric: "input_tokens",
			window: "day",
			from: new Date("2026-09-20T00:00:00.000Z"),
			to: new Date("2026-09-22T00:00:00.000Z"),
			limit: 10,
		});

		expect(result).toEqual([
			{ from: new Date("2026-09-20T00:00:00.000Z"), value: 30 },
			{ from: new Date("2026-09-21T00:00:00.000Z"), value: 30 },
		]);
	});

	it("returns no buckets for a subscriber without objects", async () => {
		await expect(
			store.readSeries({
				subscriptionId: "missing-subscription",
				metric: "generations",
				window: "day",
				from: new Date("2026-09-20T00:00:00.000Z"),
				to: new Date("2026-09-22T00:00:00.000Z"),
				limit: 10,
			}),
		).resolves.toEqual([]);
	});
});
