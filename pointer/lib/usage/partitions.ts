/**
 * DDL for the usage archive: a weekly range-partitioned table whose partitions
 * are created ahead of time by pg_cron.
 *
 *   usage_event (partitioned parent)
 *   ├── usage_event_2026w36   [2026-08-31, 2026-09-07)
 *   ├── usage_event_2026w37   [2026-09-07, 2026-09-14)
 *   └── usage_event_default   anything the scheduler failed to provide for
 *
 * # Why this is not in the Better Auth plugin
 *
 * `plugins/usage-plugin.ts` declares the columns so the CLI keeps them in sync,
 * but Kysely's `createTable` cannot emit `PARTITION BY RANGE`. The CLI's
 * introspection reports a partitioned table as an existing `BASE TABLE`, so as
 * long as this runs first (see `scripts/migrate-usage.ts`) the CLI skips
 * creation and confines itself to `ALTER TABLE ADD COLUMN`.
 *
 * # Why one index
 *
 * A write-heavy table pays for every index on every insert. One unique index
 * covers both jobs: the leading `("subscriptionId", "usageTimestamp")` prefix
 * is the history query's range scan, and the full tuple is what
 * `ON CONFLICT DO NOTHING` infers on to absorb an at-least-once replay. A
 * unique index on a partitioned table has to contain the partition key, which
 * this one does.
 */

import type { Pool } from "pg";

/** Weeks provisioned beyond the current one. A missed run is then harmless. */
const WEEKS_AHEAD = 2;
/** Daily, not weekly: the function is idempotent and cheap, so retry often. */
const MAINTENANCE_SCHEDULE = "11 3 * * *";
const CRON_JOB_NAME = "usage-event-partitions";

/**
 * Statements that only need stock PostgreSQL. Applied in order, each one
 * idempotent, so a re-run is a no-op.
 */
const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS usage_event (
     "deduplicationId" text        NOT NULL,
     "subscriptionId"  text        NOT NULL,
     "usageTimestamp"  timestamptz NOT NULL,
     "model"           text        NOT NULL,
     "inputTokens"     integer     NOT NULL,
     "outputTokens"    integer     NOT NULL,
     "creditsMilli"    integer     NOT NULL,
     "usageSource"     text        NOT NULL,
     "planId"          text        NOT NULL
   ) PARTITION BY RANGE ("usageTimestamp")`,

  // Created before any weekly partition so a write arriving mid-migration has
  // somewhere to land. Caveat: once it holds rows for week W, creating W's
  // partition fails, and recovery is a manual DETACH and re-insert.
  `CREATE TABLE IF NOT EXISTS usage_event_default
     PARTITION OF usage_event DEFAULT`,

  `CREATE UNIQUE INDEX IF NOT EXISTS usage_event_lookup
     ON usage_event ("subscriptionId", "usageTimestamp", "deduplicationId")`,

  // Bounds are spelled with an explicit +00 offset. A bare date literal would
  // be cast to timestamptz using the server's TimeZone, which nothing here
  // controls, and the partition would straddle the wrong seven days.
  `CREATE OR REPLACE FUNCTION usage_event_add_week(week_start date)
   RETURNS void
   LANGUAGE plpgsql
   AS $fn$
   DECLARE
     partition_name text := format('usage_event_%s', to_char(week_start, 'IYYY"w"IW'));
     range_start    text := to_char(week_start,     'YYYY-MM-DD') || ' 00:00:00+00';
     range_end      text := to_char(week_start + 7, 'YYYY-MM-DD') || ' 00:00:00+00';
   BEGIN
     EXECUTE format(
       'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_event
          FOR VALUES FROM (%L) TO (%L)',
       partition_name, range_start, range_end
     );
   END;
   $fn$`,

  // ISO weeks start Monday, matching `snapToWindow` in summary.ts.
  `CREATE OR REPLACE FUNCTION usage_event_maintain(weeks_ahead integer DEFAULT ${WEEKS_AHEAD})
   RETURNS void
   LANGUAGE plpgsql
   AS $fn$
   DECLARE
     current_week date := date_trunc('week', now() AT TIME ZONE 'UTC')::date;
   BEGIN
     FOR week_offset IN 0..weeks_ahead LOOP
       PERFORM usage_event_add_week(current_week + week_offset * 7);
     END LOOP;
   END;
   $fn$`,

  // Runs on every migration too, so a fresh database has its partitions before
  // pg_cron's first tick — and so an environment without pg_cron still works,
  // one deployment at a time.
  `SELECT usage_event_maintain(${WEEKS_AHEAD})`,
];

/**
 * Statements that need the pg_cron extension. `cron.schedule` upserts on the
 * job name, so re-running only rewrites the schedule.
 */
const SCHEDULER_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS pg_cron`,
  `SELECT cron.schedule(
     '${CRON_JOB_NAME}',
     '${MAINTENANCE_SCHEDULE}',
     'SELECT usage_event_maintain(${WEEKS_AHEAD})'
   )`,
];

type Queryable = Pick<Pool, "query">;

async function run(db: Queryable, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await db.query(statement);
  }
}

/**
 * Brings the usage archive up to date. Must run before the Better Auth CLI on
 * a fresh database, or the CLI creates an unpartitioned `usage_event` first.
 *
 * pg_cron is applied separately and tolerantly: it needs
 * `shared_preload_libraries` plus a restart, which a plain local Postgres will
 * not have. Losing the scheduler degrades partitioning to once-per-deployment
 * rather than breaking it, so it is worth a warning rather than a failure.
 */
export async function applyUsageSchema(db: Queryable): Promise<void> {
  await run(db, TABLE_STATEMENTS);

  try {
    await run(db, SCHEDULER_STATEMENTS);
  } catch (err) {
    console.warn(
      "[usage-schema] pg_cron unavailable — partitions will only be created " +
        "by this migration. Add pg_cron to shared_preload_libraries and " +
        "restart the server to schedule them.",
      err,
    );
  }
}
