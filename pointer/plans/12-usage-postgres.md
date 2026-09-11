# Usage events to weekly-partitioned Postgres

Archive every flushed usage event in Postgres alongside the Chargebee batch
ingest, and serve the usage-history read path locally. Chargebee stays the
billing system of record; its API quota stops being spent on a page subscribers
refresh several times a day.

## Where this forks off the existing pipeline

```
POST /api/generate ─▶ recordUsageEvent() ─▶ XADD pointer:usage:events
                                                     │
                                            flush loop (60s, 500)
                                                     │
                                    ┌────────────────┴────────────────┐
                                    ▼                                 ▼
                            recordUsageBatch()                 batchIngest()
                            Postgres usage_event                 Chargebee
                                    │                                 │
                                    └──────────▶ XACK + XDEL ◀────────┘

GET /api/usage/history ◀── readUsageSeries() ◀── Postgres usage_event
```

**Both sinks are fed from one flush pass, not a second consumer group.**
`ackUsageEvents` does `XACK` *and* `XDEL` (`lib/usage/stream.ts`), so whichever
group settled an entry first would delete it out from under the other. Writing
inside the existing pass sidesteps that entirely and keeps the delivery
guarantees already in place.

**Postgres is written first, before the expiry split.** Chargebee refuses any
`usage_timestamp` older than 12 hours; Postgres has no such limit, and since it
is now the read path, those events belong in history anyway.

**A failed Postgres write abandons the pass.** Nothing is acknowledged, no batch
is ingested, and the next tick reclaims the whole lot. History is what the
subscriber sees, so a silent gap is worse than a delay. The cost is that a long
Postgres outage can let events age out of Chargebee's backdating window — an
acceptable trade when the alternative is a chart with holes in it.

## Schema and migration mechanics

Two facts from `better-auth/dist/db/get-migration.mjs` decide how this splits:

- Table existence comes from Kysely introspection (`relkind in ('r','v','p','f')`)
  intersected with `information_schema.tables` where `table_type = 'BASE TABLE'`.
  Postgres reports a partitioned table as `BASE TABLE`, so the CLI sees the
  parent and skips `CREATE TABLE`, then manages future columns with
  `ALTER TABLE ADD COLUMN` (which propagates to partitions). Verified against a
  live database: `getMigrations` returns `toBeCreated: []`.
- Index introspection is hard-scoped to `AND table_class.relkind = 'r'`. An index
  on a partitioned parent is invisible to it, so **`indexes` must not be
  declared in the plugin schema** or every migration would retry
  `CREATE INDEX` and fail.

So `plugins/usage-plugin.ts` declares the columns, and
`lib/usage/partitions.ts` owns partitioning, the index, and pg_cron. Ordering is
enforced by one `db:migrate` script that runs the DDL first.

## Table

```sql
CREATE TABLE usage_event (
  "deduplicationId" text        NOT NULL,
  "subscriptionId"  text        NOT NULL,
  "usageTimestamp"  timestamptz NOT NULL,
  "model"           text        NOT NULL,
  "inputTokens"     integer     NOT NULL,
  "outputTokens"    integer     NOT NULL,
  "creditsMilli"    integer     NOT NULL,
  "usageSource"     text        NOT NULL,
  "planId"          text        NOT NULL
) PARTITION BY RANGE ("usageTimestamp");

CREATE UNIQUE INDEX usage_event_lookup
  ON usage_event ("subscriptionId", "usageTimestamp", "deduplicationId");
```

One index, two jobs: the leading `("subscriptionId", "usageTimestamp")` prefix is
the history query's range scan, and the full tuple is the conflict target that
makes an at-least-once replay a no-op. A unique index on a partitioned table has
to contain the partition key, which it does.

No `id` and no primary key — Better Auth only adds `id` inside its own
`createTable`, and a PK would be a second index to maintain on every insert.

Column notes:

- `creditsMilli` is credits x 1000 as an `integer`. `consumeGenerationUsage`
  divides milli-credits by 1000, so the value is fractional; Better Auth has no
  decimal type, and declaring `number` against a `numeric` column would warn on
  every migration.
- `generation_id` is dropped: the generation path sets it and `deduplicationId`
  to the same `traceId`.
- Types match Better Auth's Postgres map (`string`→`text`, `date`→`timestamptz`,
  `number`→`integer`), so no drift warnings.

## Partitions via pg_cron

`usage_event_add_week(date)` creates one week's partition; `usage_event_maintain(n)`
walks the current ISO week plus `n` ahead. Both idempotent.

```sql
SELECT cron.schedule('usage-event-partitions', '11 3 * * *',
                     'SELECT usage_event_maintain(2)');
SELECT usage_event_maintain(2);   -- fresh database, before cron's first tick
```

Daily rather than weekly: the function is cheap and idempotent, so a missed run
should cost nothing. Two weeks of lookahead gives roughly 16 days of grace.

Bounds are emitted as explicit `+00` literals. A bare `date` cast against
`timestamptz` would use the server's `TimeZone`, which nothing here controls, and
the partition would straddle the wrong seven days.

A `DEFAULT` partition is the safety net so a stalled scheduler parks rows instead
of failing writes. Caveat: once it holds rows for week W, creating W's partition
fails, and recovery is a manual `DETACH` and re-insert.

pg_cron is applied tolerantly. It needs `shared_preload_libraries` plus a
restart, which a plain Postgres will not have; losing it degrades partitioning to
once per deployment rather than breaking it, so it warrants a warning, not a
failure.

## Read path

`fetchUsageSummary` keeps its signature and response shape — `/api/usage/history`
and `MetricCard` are untouched — but now delegates to `readUsageSeries`:

```sql
SELECT date_trunc($1, "usageTimestamp", 'UTC') AS bucket, <aggregate> AS value
  FROM usage_event
 WHERE "subscriptionId" = $2 AND "usageTimestamp" >= $3 AND "usageTimestamp" < $4
 GROUP BY bucket ORDER BY bucket LIMIT $5
```

`<aggregate>` comes from a closed map keyed by `UsageMetric`, never interpolated
from a request. `date_trunc` is given an explicit `'UTC'` so week and month
boundaries do not follow the server's timezone.

`GROUP BY` omits empty buckets while the chart spaces points evenly, so a sparse
series would misdate every bar. `fillBuckets` walks the range one window at a
time and reads zero where nothing was recorded, which is also where `truncated`
is decided.

## Files

New:

- `plugins/usage-plugin.ts` — the `usageEvent` model, registered in `lib/auth.ts`
- `lib/usage/partitions.ts` — idempotent DDL and `applyUsageSchema`
- `scripts/migrate-usage.ts` — applies it
- `lib/usage/store.ts` — `recordUsageBatch` and `readUsageSeries`
- `lib/usage/store.integration.test.ts`
- `docker/postgres/Dockerfile` — Postgres 18 with `postgresql-18-cron`

Changed:

- `lib/usage/flush.ts` — archive the collected batch before the Chargebee splits
- `lib/usage/summary.ts` — read from the store, fill empty buckets, drop paging
- `lib/usage/flush.test.ts`, `lib/usage/summary.test.ts`
- `package.json` — `db:migrate`, `db:migrate:local`
- `infra/migrate.tf` — run `pnpm db:migrate`
- `infra/rds.tf`, `infra/locals.tf` — `shared_preload_libraries`,
  `cron.database_name`, and a `db_name` local to avoid a Terraform cycle
- `docker-compose.yaml` — build the pg_cron image, pass the server flags
- `ARCHITECTURE.md`, `infra/README.md`, usage page and route comments

## Loose ends

`shared_preload_libraries` is static: Terraform stages it, and the RDS instance
needs one manual reboot before `CREATE EXTENSION pg_cron` succeeds. Documented in
`infra/README.md`.

The local Postgres image moves from alpine to Debian for pg_cron, which changes
the collation provider. The dev volume should be recreated rather than reused.

`usageIngestEnabled()` still gates `recordUsageEvent`, so an environment without
`CHARGEBEE_USAGE_INGEST_ENABLED=true` buffers nothing and therefore has no
Postgres history either. Decoupling the two flags would let local development
exercise the read path without a Chargebee site — deliberately left alone.
