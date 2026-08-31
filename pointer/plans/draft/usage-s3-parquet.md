# Usage events to S3 as Hive-partitioned Parquet

Tee the usage-event buffer into an S3 data lake alongside the Chargebee batch
ingest, and serve the usage page's history from Parquet via embedded DuckDB.
Chargebee stops being the read path for a page a subscriber refreshes several
times a day, and its API budget is preserved for billing operations.

## Where this forks off the existing pipeline

```
POST /api/generate ─▶ recordUsageEvent()
                          │
                          ├─ XADD pointer:usage:events   ─▶ flush loop  ─▶ Chargebee batchIngest
                          │                                   (60s, 500)
                          └─ XADD pointer:usage:exports  ─▶ export loop ─▶ DuckDB COPY ─▶ s3://.../events
                                                              (15min, 5000)
                                                                              │
                                                          rollup loop (daily) ┘
                                                                              ▼
                                                                    s3://.../rollup
                                                                              │
GET /api/usage/history ◀── DuckDB read_parquet ◀──────────────────────────────┘
```

**A second consumer group on `pointer:usage:events` would silently lose events.**
`ackUsageEvents` in `lib/usage/stream.ts` does `XACK` *and* `XDEL`:

```193:201:lib/usage/stream.ts
export async function ackUsageEvents(ids: string[]): Promise<void> {
  if (!ids.length) return;

  await getRedis()
    .multi()
    .xack(USAGE_STREAM_KEY, CONSUMER_GROUP, ...ids)
    .xdel(USAGE_STREAM_KEY, ...ids)
    .exec();
}
```

`XDEL` removes the entry outright. Any group that had not yet read it never
will, and the Chargebee flusher runs 15x more often than the exporter would, so
it would win nearly every race. Dropping the `XDEL` instead trades that for
blind `MAXLEN` trimming plus a coupled memory profile — a stalled exporter would
grow the stream the flusher shares.

So: **tee at write time into a second stream.** Two `XADD`s in one pipeline, one
round trip, independent groups, independent trimming, independent failure. The
destructive-ack property of the existing pipeline is untouched.

## Layout

Event time, not export time, decides the partition. A replayed or late event
belongs to the day it happened.

```
s3://pointer-usage-<env>/
├── events/                              at-least-once, may contain duplicates
│   └── dt=2026-08-30/
│       ├── hour=14/  <uuid>.parquet      one file per export pass
│       └── hour=15/  <uuid>.parquet
└── rollup/                              deduped, one row per (sub, day, model)
    └── subscription_id=cbsub_1AB/
        ├── dt=2026-08-29/ <uuid>.parquet
        └── dt=2026-08-30/ <uuid>.parquet
```

Two datasets because the two partition orders serve opposite queries and neither
alone works:

- `dt`-first on `events` keeps the write cheap. One pass writes one file per
  hour partition regardless of how many subscribers are active.
- `subscription_id`-first on `rollup` makes the user-facing read surgical.
  DuckDB lists exactly one prefix and reads one small file per day.

Partitioning the raw `events` by `subscription_id` instead would fan every
export pass out to one tiny file *per active subscriber*: 1,000 subscribers at a
15-minute interval is 96,000 objects a day. See Pitfall 2.

`dt` auto-casts to `DATE` and `hour` to `BIGINT` under DuckDB's `hive_types`
auto-detection, so no `hive_types` struct is needed.

## Writer: DuckDB `COPY ... PARTITION_BY ... APPEND`

The worker already has to embed DuckDB for the read path, so it also serves as
the Parquet encoder. No second dependency, and no viable pure-JS Parquet writer
worth taking on.

Each pass drains up to 5,000 entries (no Chargebee ceiling applies here — bigger
reads mean bigger files), appends them to an in-memory table via the Node Neo
appender, then:

```sql
COPY (
  SELECT subscription_id, generation_id, model, plan_id, usage_source,
         input_tokens, output_tokens, credits_consumed, usage_timestamp,
         CAST(usage_timestamp AS DATE)      AS dt,
         date_part('hour', usage_timestamp) AS hour
  FROM staged
  ORDER BY subscription_id, usage_timestamp
) TO 's3://pointer-usage-<env>/events'
  (FORMAT parquet, PARTITION_BY (dt, hour), APPEND, COMPRESSION zstd);
```

`APPEND` is the only option available: DuckDB's docs state overwriting "is not
supported" on remote filesystems. It behaves as
`OVERWRITE_OR_IGNORE, FILENAME_PATTERN '{uuid}'` plus an existence check that
re-rolls the UUID on collision.

`ORDER BY subscription_id` is load-bearing, not cosmetic: it clusters each
subscriber into contiguous row groups so Parquet min/max statistics let an
ad-hoc single-tenant scan of `events` skip most of them.

Redis entries are acked only after the `COPY` returns, so a crash replays the
batch. S3 has no equivalent of Chargebee's dedup, so duplicates are expected in
`events` and removed by the rollup.

## Rollup: one file per subscriber-day

Runs daily at 13:00 UTC for the prior UTC day — a 13-hour lag, comfortably past
Chargebee's 12-hour backdating window, so nothing more can land in that day.

```sql
COPY (
  SELECT subscription_id, dt, model,
         sum(input_tokens)     AS input_tokens,
         sum(output_tokens)    AS output_tokens,
         sum(credits_consumed) AS credits_consumed,
         count(*)              AS generations
  FROM (
    SELECT DISTINCT ON (generation_id) *
    FROM read_parquet('s3://.../events/dt=2026-08-29/**/*.parquet',
                      hive_partitioning = true)
  )
  GROUP BY subscription_id, dt, model
) TO 's3://pointer-usage-<env>/rollup'
  (FORMAT parquet, PARTITION_BY (subscription_id, dt), APPEND);
```

`DISTINCT ON (generation_id)` is where at-least-once delivery is collapsed back
to exactly-once. Because the rollup is the read path, a duplicate never reaches
a subscriber.

Re-running needs the day's `rollup/*/dt=<day>/` objects deleted first, or
`APPEND` doubles every number. That is a `ListObjectsV2` + `DeleteObjects` call
through `@aws-sdk/client-s3` — see Pitfall 3 for why it cannot be atomic.

Only one task may run it. Consumer groups make the export loop safe to run on
every task, but the rollup is a whole-day rewrite: N tasks produce N copies.
Guarded by a Redis `SET NX EX` lock on `usage:rollup:lock:<date>`, the same
pattern `lib/usage/counters.ts` already uses for threshold dedupe.

## Read path

`USAGE_HISTORY_SOURCE=lake|chargebee` selects the source in
`app/api/usage/history/route.ts`. `lake` is the default; `chargebee` keeps
`lib/usage/summary.ts` reachable as a fallback and as the reconciliation
reference (Pitfall 5). The route's contract and the `UsageSummarySeries` shape
are unchanged, so `app/usage/page.tsx` needs no edit.

```sql
SELECT dt, sum(input_tokens) AS value
FROM read_parquet($path, hive_partitioning = true)
WHERE dt >= $from AND dt < $to
GROUP BY dt ORDER BY dt;
```

`$path` is `s3://.../rollup/subscription_id=<id>/dt=*/*.parquet`. Interpolating
the subscription id into the *path* rather than a `WHERE` clause is the whole
point — DuckDB lists one prefix instead of globbing every tenant. It is a bound
parameter, not string concatenation, and the id is still validated against
`^[A-Za-z0-9_-]+$` first to keep `../` out of a path DuckDB will resolve.

Window handling:

- `day`, `week`, `month` — `date_trunc` over the rollup.
- `hour` — the rollup has no sub-day grain. Falls back to a filtered `events`
  scan, capped at 7 days so it cannot walk the whole lake.

An empty glob raises `No files found that match the pattern`, which is the
normal state for a subscriber with no history. Caught and returned as an empty
series, otherwise every new subscriber's first page load is a 500.

Two caches sit in front, because otherwise this trades Chargebee's quota for S3
round trips on every refresh:

- Redis, 300s, keyed by subscription + metric + window + range.
- DuckDB's own `enable_external_file_cache` and HTTP metadata cache, for reuse
  within a process.

## Layering

```
app/api/usage/history/route.ts   auth, subject, validation, source selection
lib/usage/lake/query.ts          rollup -> UsageSummarySeries, caching
lib/usage/lake/rollup.ts         daily dedupe + aggregate + rewrite
lib/usage/lake/export.ts         batch -> appender -> COPY
lib/usage/lake/layout.ts         bucket, prefixes, partition keys, id validation
lib/usage/lake/client.ts         DuckDB instance, S3 secret, extensions, limits
lib/usage/lake/objects.ts        S3 list/delete driver (@aws-sdk/client-s3)
lib/usage/stream.ts              the tee; both streams, both groups
workers/usage-export-loop.ts     15-minute scheduling
workers/usage-rollup-loop.ts     daily scheduling + Redis lock
```

`client.ts` is the only file that constructs DuckDB, mirroring how `lib/redis.ts`
and `lib/db.ts` own their singletons. `query.ts` holds no S3 SDK and
`objects.ts` no SQL.

## Plain S3 vs S3 Tables

**Plain S3 + Hive Parquet** — what this plan builds.

- Read is `read_parquet(...)` with `httpfs`. No catalog, no `ATTACH`, no
  credentials beyond an S3 secret. The same glob works from the DuckDB CLI,
  DuckDB-Wasm, Python, or a laptop.
- Write is `COPY ... PARTITION_BY ... APPEND`. Stable, not experimental.
- Cost is storage plus PUT/GET. Nothing else.
- LocalStack Community emulates S3 fully, so the free local loop survives.
- No ACID, no atomic partition replacement, no row-level delete, no schema
  registry. Compaction is yours. Pitfalls 2, 3, and the GDPR note below are all
  consequences of this row.

**S3 Tables** — fully managed Apache Iceberg in purpose-built table buckets.

- Continuous compaction, snapshot expiry, and unreferenced-file cleanup are
  automatic. That erases Pitfall 2 entirely.
- Snapshot isolation makes the rollup rewrite a single atomic commit
  (`MERGE INTO` or `DELETE` + `INSERT`). Readers never observe a torn partition.
  That erases Pitfall 3.
- Row-level `DELETE` makes GDPR erasure one statement instead of a
  find-and-rewrite job across Parquet files.
- Schema evolution is tracked by the catalog rather than by `union_by_name`
  convention.
- Up to 10x higher TPS than Iceberg on general-purpose buckets, and
  Intelligent-Tiering cuts storage cost up to 80%.
- Any Iceberg engine reads it — Athena, Trino, Spark, Snowflake, Redshift —
  which plain Parquet globs only approximate.

Why not now:

- **Local development stops being free.** LocalStack's S3 Tables provider is
  Ultimate-tier and needs `LOCALSTACK_AUTH_TOKEN`. `docker-compose.yaml` pins
  `localstack:4.14.0` precisely to stay token-free ("Do not bump to a 2026.x tag
  unless you're prepared to supply LOCALSTACK_AUTH_TOKEN"). A reference
  architecture that cannot be run locally without a paid licence loses most of
  its point.
- **DuckDB's S3 Tables support is labelled experimental.** Writes require an
  attached REST catalog (`ATTACH 'arn:aws:s3tables:...' (TYPE iceberg,
  ENDPOINT_TYPE s3_tables)`), are merge-on-read only, and fail outright on
  tables whose `write.update.mode` is not `merge-on-read`.
- Extra AWS charges for object monitoring and compaction on top of storage and
  requests.
- New Terraform surface: table buckets, namespaces, and Glue/Lake Formation
  wiring for engine access.

**Verdict.** Start on plain S3. The `lib/usage/lake/` boundary keeps storage
swappable, and DuckDB reads both through nearly identical SQL, so a migration
touches `client.ts` and `layout.ts` and little else. Move to S3 Tables when
hand-rolled compaction becomes a chore, when row-level erasure becomes a
compliance requirement, or when an engine other than DuckDB needs concurrent
access.

## Pitfalls

**1. A second consumer group on the existing stream loses events.** Covered
above; the reason for the tee. Cost of the tee: buffer memory doubles to ~60MB
at `MAXLEN ~ 100_000` per stream, and the hot path does two `XADD`s in one
pipelined round trip.

**2. Small files. The dominant risk.** DuckDB's guidance is at least 100MB per
partition; a 200-byte usage event in its own Parquet file, footer and all, is
the opposite. At a 60-second interval this produces 1,440 objects per day per
partition path, and a 30-day read becomes tens of thousands of ranged GETs.
Mitigated by a 15-minute export interval, by partitioning raw `events` on time
rather than tenant, and by the rollup — which is not an optimisation here but
load-bearing. Without it the read path does not perform.

**3. S3 has no atomic partition replacement.** Remote `OVERWRITE` is
unsupported, so a rollup re-run must delete the old objects and then write new
ones. A reader landing between the two sees an undercount; reversing the order
makes it an overcount, which is worse for a usage chart. Bounded in practice —
the rollup targets a day already 13 hours old and is rarely re-run — but it is
real, and it is precisely the problem Iceberg snapshots exist to solve. The
principled fix is S3 Tables, not more code.

**4. Duplicates are guaranteed in `events`.** At-least-once delivery plus no S3
dedup. Handled by `DISTINCT ON (generation_id)` in the rollup. Any future
consumer reading `events` directly must dedupe too — worth a comment in
`layout.ts` rather than folklore.

**5. Three sources of truth can now disagree.** Redis enforces, Chargebee
invoices, S3 displays. If the exporter and the flusher diverge — one
dead-letters a batch the other accepted — the subscriber sees numbers that do
not match their invoice, which is the worst possible support ticket. Mitigation:
a daily reconciliation script comparing the lake rollup against
`usage_summary` for a sampled subscription and day, alarming on drift. This is
the main reason to keep `lib/usage/summary.ts` rather than delete it.

**6. The app image must leave Alpine.** `@duckdb/node-bindings-linux-x64` is
glibc-only; there is no musl build. The `Dockerfile` runs `node:22-alpine`
throughout and must move to `node:22-bookworm-slim`. Image size grows from
roughly 80MB to 200MB plus 40-60MB of DuckDB bindings. Not optional and not
small.

**7. DuckDB downloads extensions on first `LOAD`.** `httpfs` and `aws` are
fetched from `extensions.duckdb.org` at runtime, which is an egress dependency
and a cold-start spike in a locked-down ECS task. Bake them into the image at
build time with a pinned `DUCKDB_EXTENSION_DIRECTORY`.

**8. DuckDB competes with Next.js for the same container.** `SET memory_limit`
and `SET threads` in `client.ts` to keep an over-broad query from starving
request handling, and expect to raise the task's memory in `infra/ecs.tf`.

**9. The app and worker share one IAM task role.** `aws_iam_role.task` in
`infra/ecs.tf:87` is referenced by `infra/worker.tf:33` and
`infra/migrate.tf:23`. Attaching lake write permissions to it would give the
public-facing app the ability to rewrite billing history. Split out a worker
task role, or accept a real blast-radius increase.

**10. Days are never fully sealed.** Event-time partitioning means a late event
lands in an old partition. Bounded by Chargebee's 12-hour window and by the
dead-letter path, which is why the rollup lags 13 hours. Shortening that lag
starts dropping events from the rollup.

**11. Still per-subscription only.** `UsageEventProperties` carries no
`user_id`, so a team plan cannot be broken down by member — unchanged from
today. Ingest is schemaless, so adding it is cheap, but `scripts/catalog.ts`
`column_definitions` and the Chargebee meter queries would have to follow. If it
is ever wanted, add it now rather than backfill Parquet later.

**12. At this scale, a Postgres table would do.** If the only goal is sparing
Chargebee's API budget, a `usage_daily_rollup` table in the Postgres already
running would achieve it with a fraction of the moving parts: no S3, no DuckDB,
no native module, no base-image change, no compaction. The lake earns its keep
when usage volume outgrows Postgres, when analysts want ad-hoc SQL over raw
events, or when the point is to *demonstrate* the lakehouse pattern — which, for
a reference architecture, is a legitimate reason. It is not the cheapest way to
solve the stated problem, and that should be a deliberate choice.

## Changes

New:

- `lib/usage/lake/client.ts` — DuckDB instance, S3 secret, extension load, limits
- `lib/usage/lake/layout.ts` — bucket, prefixes, partition keys, id validation
- `lib/usage/lake/export.ts` — batch to `COPY ... PARTITION_BY ... APPEND`
- `lib/usage/lake/rollup.ts` — daily dedupe, aggregate, delete-then-write
- `lib/usage/lake/query.ts` — rollup to `UsageSummarySeries`, Redis cache
- `lib/usage/lake/objects.ts` — S3 list/delete driver
- `lib/usage/lake/{layout,query,rollup}.test.ts`
- `lib/usage/lake/export.integration.test.ts` — LocalStack, `RUN_S3_TESTS=1`
- `workers/usage-export-loop.ts`, `workers/usage-rollup-loop.ts` (+ tests)
- `scripts/reconcile-usage-lake.ts` — lake vs. Chargebee drift check
- `docker/localstack/init-s3.sh`, `infra/s3.tf`

Modified:

- `lib/usage/stream.ts` — the tee, second stream key, `usage-export` group
- `app/api/usage/history/route.ts` — `USAGE_HISTORY_SOURCE` selection
- `workers/chargebee-webhook-worker.ts` — start both new loops, drain on SIGTERM
- `next.config.ts` — `serverExternalPackages`, tracing for native bindings
- `Dockerfile` — glibc base, pre-baked DuckDB extensions
- `docker-compose.yaml` — `SERVICES: sqs,s3`, mount `init-s3.sh`
- `lib/events/types.ts` — `app.usage_exported`, `app.usage_rollup_completed`
- `.env.example`, `infra/variables.tf`, `infra/locals.tf`, `infra/ecs.tf`
- `ARCHITECTURE.md` — the lake path in the component diagram and data stores
- `package.json` — `@duckdb/node-api`, `@aws-sdk/client-s3`

## Notes

- New env: `USAGE_LAKE_ENABLED`, `USAGE_LAKE_BUCKET`,
  `USAGE_EXPORT_INTERVAL_MS` (default 900000), `USAGE_ROLLUP_HOUR_UTC`
  (default 13), `USAGE_HISTORY_SOURCE` (default `lake`),
  `USAGE_LAKE_S3_ENDPOINT` (LocalStack only).
- DuckDB does not read `AWS_ENDPOINT_URL`. LocalStack needs an explicit
  `CREATE SECRET (TYPE s3, ENDPOINT 'localhost:4566', URL_STYLE 'path',
  USE_SSL false, ...)`; production uses `PROVIDER credential_chain` against the
  task role.
- Like the flush loop, both new loops need the ECS worker runtime.
  `worker_runtime = "lambda"` has no long-running process. `export.ts` and
  `rollup.ts` stay runtime-agnostic so EventBridge could drive them later.
- Lifecycle policy on the bucket: transition `events/` to Glacier IR after 90
  days, keep `rollup/` in Standard since it is the read path.
- `USAGE_LAKE_ENABLED=false` makes the tee, both loops, and the lake read path
  no-ops, and `USAGE_HISTORY_SOURCE=chargebee` restores today's behaviour
  exactly. Nothing here is on the critical path of a generation.
