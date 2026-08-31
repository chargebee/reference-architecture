import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPool } from "@/lib/db";

import type { BufferedUsageEvent } from "./events";
import { applyUsageSchema } from "./partitions";
import { readUsageSeries, recordUsageBatch } from "./store";
import { snapToWindow } from "./summary";

const postgresTests =
  process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

postgresTests("usage archive", () => {
  const subscriptionId = `test-${process.pid}-${Date.now()}`;
  /** Monday 00:00 UTC of the current ISO week — a provisioned partition. */
  const weekStart = snapToWindow(new Date(), "week");

  function event(
    id: string,
    at: Date,
    metrics: { input?: number; output?: number; credits?: number } = {},
  ): BufferedUsageEvent {
    return {
      deduplicationId: `${subscriptionId}-${id}`,
      subscriptionId,
      usageTimestamp: at.getTime(),
      properties: {
        generation_id: `${subscriptionId}-${id}`,
        model: "openai/gpt-4o-mini",
        input_tokens: metrics.input ?? 0,
        output_tokens: metrics.output ?? 0,
        credits_consumed: metrics.credits ?? 0,
        usage_source: "plan_quota",
        plan_id: "plan-pro",
      },
    };
  }

  async function partitionOf(id: string): Promise<string> {
    const pool = await getPool();
    const result = await pool.query<{ partition: string }>(
      `SELECT tableoid::regclass::text AS partition
         FROM usage_event
        WHERE "deduplicationId" = $1`,
      [`${subscriptionId}-${id}`],
    );
    return result.rows[0]?.partition ?? "";
  }

  beforeAll(async () => {
    await applyUsageSchema(await getPool());
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool.query(`DELETE FROM usage_event WHERE "subscriptionId" = $1`, [
      subscriptionId,
    ]);
    await pool.end();
  });

  it("applies its own DDL twice without complaint", async () => {
    await expect(applyUsageSchema(await getPool())).resolves.toBeUndefined();
  });

  it("routes events into the partition for their week", async () => {
    await recordUsageBatch([
      event("this-week", new Date(weekStart.getTime() + 6 * HOUR_MS)),
      event("next-week", new Date(weekStart.getTime() + WEEK_MS + 6 * HOUR_MS)),
    ]);

    const [thisWeek, nextWeek] = await Promise.all([
      partitionOf("this-week"),
      partitionOf("next-week"),
    ]);

    expect(thisWeek).toMatch(/^usage_event_\d{4}w\d{2}$/);
    expect(nextWeek).toMatch(/^usage_event_\d{4}w\d{2}$/);
    expect(thisWeek).not.toBe(nextWeek);
  });

  it("parks an event beyond the provisioned weeks in the default partition", async () => {
    // The scheduler only runs a fortnight ahead; nothing should ever fail to
    // land, even when it is late.
    await recordUsageBatch([
      event("far-future", new Date(weekStart.getTime() + 52 * WEEK_MS)),
    ]);

    await expect(partitionOf("far-future")).resolves.toBe("usage_event_default");
  });

  it("absorbs a replayed batch instead of duplicating it", async () => {
    const replayed = [
      event("replay", new Date(weekStart.getTime() + 7 * HOUR_MS), {
        input: 10,
      }),
    ];

    await recordUsageBatch(replayed);
    await recordUsageBatch(replayed);

    const pool = await getPool();
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM usage_event
        WHERE "deduplicationId" = $1`,
      [`${subscriptionId}-replay`],
    );

    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  it("sums a metric into the requested buckets", async () => {
    const day = new Date(weekStart.getTime() + 24 * HOUR_MS);
    await recordUsageBatch([
      event("agg-a", new Date(day.getTime() + 1 * HOUR_MS), {
        input: 100,
        credits: 0.25,
      }),
      event("agg-b", new Date(day.getTime() + 1 * HOUR_MS + 60_000), {
        input: 50,
        credits: 0.25,
      }),
      event("agg-c", new Date(day.getTime() + 5 * HOUR_MS), { input: 7 }),
    ]);

    const query = {
      subscriptionId,
      from: day,
      to: new Date(day.getTime() + 24 * HOUR_MS),
      limit: 100,
    };

    const daily = await readUsageSeries({
      ...query,
      metric: "input_tokens",
      window: "day",
    });
    expect(daily).toEqual([{ from: day, value: 157 }]);

    const hourly = await readUsageSeries({
      ...query,
      metric: "input_tokens",
      window: "hour",
    });
    expect(hourly).toEqual([
      { from: new Date(day.getTime() + 1 * HOUR_MS), value: 150 },
      { from: new Date(day.getTime() + 5 * HOUR_MS), value: 7 },
    ]);

    // Stored as milli-credits, reported as credits.
    const credits = await readUsageSeries({
      ...query,
      metric: "credits_consumed",
      window: "day",
    });
    expect(credits).toEqual([{ from: day, value: 0.5 }]);

    const generations = await readUsageSeries({
      ...query,
      metric: "generations",
      window: "day",
    });
    expect(generations).toEqual([{ from: day, value: 3 }]);
  });
});
