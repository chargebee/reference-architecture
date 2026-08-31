# Chargebee usage tracking

Send one usage event per generation to Chargebee, and read it back per time
bucket for the signed-in subscriber.

## What the APIs do and don't give us

Both endpoints ship in the installed SDK (`chargebee@3.31.0`), which routes
batch ingest to `{site}.ingest.chargebee.com` on its own — the `usageEvent`
entry in `resources/api_endpoints.js` carries an `'ingest'` subdomain that
`util.js:getHost` splices into the host. No custom HTTP client.

Five constraints shape the design:

- **`usage_timestamp` must be within the last 12 hours.** A stalled flusher
  doesn't just delay events, it destroys them. Needs an expiry guard, not
  infinite retry.
- **`usage_summary` requires a metered feature id.** The existing seven
  entitlement features are `quantity`/`switch`/`custom`, and the API reference
  marks all three "not applicable for metered features", so none can be
  converted. Four new ones are created alongside them.
- **Metered feature entitlements are `range` with levels `1` and `unlimited`
  only.** They cannot carry `1000000`. Redis stays the enforcement authority;
  Chargebee usage is history.
- **`usage_summary` is eventually consistent** (labelled as such in the docs).
  Display only.
- **Windows align to `timeframe_start`, not calendar boundaries.** The start is
  snapped to a UTC boundary, or "daily" means rolling 24h.

Out of scope: linking pricing to the meters. Ingestion is schemaless and meters
are defined over already-ingested events, so switching on included-usage or
overage pricing later needs no re-ingestion and no event schema change.

## Buffer: Redis Streams, not SQS

```
POST /api/generate ──▶ meterGeneration() ──▶ XADD  (sub-ms, fire-and-forget)
                                              │
                                              │  XREADGROUP COUNT 500
                                              ▼
                            pointer-worker (existing ECS service)
                               usage flush loop, every 60s
                                              │
                                              ▼
                              usageEvent.batchIngest(500 events)
```

- `XREADGROUP COUNT 500` yields exactly one Chargebee batch per read. SQS
  `ReceiveMessage` caps at 10 messages, so one batch would cost 50 round trips.
- `XADD` on an open connection is sub-millisecond. `SendMessage` is a 10-30ms
  HTTPS call on the hot path of every generation.
- Consumer groups plus the pending-entries list give at-least-once delivery and
  crash recovery without a second queue or leader election.
- No new Terraform, no per-request cost.

Trade-off: weaker durability than SQS. `infra/redis.tf` runs a single
`cache.t4g.micro` on `default.redis7` with no AOF, so a node loss drops up to a
minute of usage. Mitigated by dedup ids making replay safe; production should
enable AOF or add a replica. Local `docker-compose.yaml` already runs
`--appendonly yes`.

## Flusher: inside the existing worker

`worker_min_count` defaults to 1, so `pointer-worker` never scales to zero, and
consumer groups fan entries across however many tasks autoscaling creates — the
same no-coordination property the SQS consumer already relies on. The flush loop
runs alongside `Consumer.start()`. Zero new components.

Passes are self-scheduling rather than a fixed `setInterval`, so they cannot
overlap: a slow pass delays the next one instead of stacking a second consumer
on the same stream. Each pass moves at most one batch and then reschedules after
1s if the buffer is still deep *and* the pass settled something, otherwise after
the configured interval. A backlog therefore clears in seconds rather than one
batch a minute, while a Chargebee outage — deep buffer, nothing settled — falls
back to the idle interval instead of retrying a broken upstream every second.

Caveat: `worker_runtime = "lambda"` has no long-running process. The loop
requires the ECS runtime; `lib/usage/flush.ts` stays runtime-agnostic so an
EventBridge-scheduled Lambda can drive it later without a rewrite.

## Metered features

Declared in `scripts/catalog.ts`, created by bootstrap stage 6. One ingested
event feeds all four, since each meter selects its own columns.

- `Input tokens` — unit `token` — `SELECT SUM(input_tokens) FROM events`
- `Output tokens` — unit `token` — `SELECT SUM(output_tokens) FROM events`
- `Credits consumed` — unit `credit` — `SELECT SUM(credits_consumed) FROM events`
- `Generations` — unit `request` — `SELECT COUNT(generation_id) FROM events`

`create` takes no `id`; Chargebee derives one from the name (`API Calls` ->
`API-Calls`). The catalog declares the expected id and bootstrap fails with the
actual one if the derivation differs, so runtime lookups stay static instead of
listing meters on every read. Idempotency goes through `cb.meter.list({ name })`
because `meteredFeature` has no `retrieve`. There is also no `update`: a drifted
`query` is reported and the stage stops, rather than delete-and-recreate, which
would discard aggregation history.

Column names in each query must match the ingested `properties` keys exactly, so
`column_definitions` is derived from the `UsageEventProperties` schema in the
same file and a query cannot reference a property that isn't declared.

## Event payload

```
deduplication_id  traceId          uuidv7, exactly the 36-char max
subscription_id   subject.chargebeeSubscriptionId
usage_timestamp   Date.now()       epoch ms
properties        { generation_id, model, input_tokens, output_tokens,
                    credits_consumed, usage_source, plan_id }
```

`traceId` already exists per request in `app/api/generate/route.ts` and already
ties that request's events together, so it is the dedup id for free.

Only settled generations are recorded. A quota denial never incremented the
local counters, so reporting it to Chargebee would put the two out of step.

## Correctness

| Case | Handling |
| --- | --- |
| Crash between ingest and ack | Batch replays; Chargebee dedupes on (`deduplication_id`, `subscription_id`, `usage_timestamp`) |
| Partial batch failure | `batchIngest` returns `failed_events`; the accepted entries are acked and the rest stay pending |
| Failures Chargebee won't attribute | Whole batch retried — safe, because ingest is idempotent |
| Worker dies holding entries | `XPENDING` finds them by idle time, `XCLAIM` moves them to a live consumer |
| Event older than 11h | Parked on the dead-letter stream; Chargebee would reject it permanently |
| Rejected 5 times | Parked on the dead-letter stream |
| Redis down at write time | Logged and swallowed; a generation must never fail because telemetry did |
| Chargebee down | Nothing settles, so the loop drops back to its idle interval instead of retrying every second |
| UBB not enabled on the site | `CHARGEBEE_USAGE_INGEST_ENABLED=false` makes the write a no-op and the loop not start |

The delivery count comes from `XPENDING` before the claim, so it lags the true
attempt count by one. That makes parking conservative, never premature.

## Read path

`GET /api/usage/history?metric=&window=&from=&to=` resolves the subject exactly
as `app/api/usage/route.ts` does, snaps `timeframe_start` to a UTC boundary for
the requested window (weeks to Monday, per ISO-8601), and pages until
`next_offset` is absent. `aggregated_value` is typed `string` by the SDK and
coerced. Paging stops at 1,000 buckets and flags `truncated` so an over-broad
range — hourly across a year — cannot spin.

Per-subscription only: `plan-team` cannot be broken down by member. That would
have to come from local data.

## Layering

```
app/api/usage/history/route.ts   auth, subject, query validation, status codes
lib/usage/summary.ts             Chargebee usage summary driver, window math
lib/usage/events.ts              recordUsageEvent() — the domain write API
lib/usage/stream.ts              Redis Streams mechanics: group, read, ack, reclaim
lib/usage/ingest.ts              Chargebee batch ingest driver, failed_events
lib/usage/flush.ts               the pump: read -> ingest -> ack. Runtime-agnostic
workers/usage-flush-loop.ts      scheduling wrapper started by the existing worker
```

`app/api/generate/stream.ts` calls `recordUsageEvent` and never sees Redis or
Chargebee, matching how it already calls `emit`. `ingest.ts` holds no Redis and
`stream.ts` no Chargebee; `flush.ts` is the only file that knows both exist.

## Changes

- `scripts/catalog.ts` — `meteredFeatures`, `UsageEventProperties`, `usageEventColumns`
- `scripts/bootstrap-chargebee.ts` — stage 6: metered features, id assertion, drift refusal
- `scripts/catalog.test.ts` — meter queries only aggregate declared columns
- `lib/usage/events.ts` — new, `recordUsageEvent()` and the enablement gate
- `lib/usage/stream.ts` — new, consumer group driver
- `lib/usage/ingest.ts` — new, `batchIngest` mapping, expiry and failure splits
- `lib/usage/summary.ts` — new, summary reads, calendar snapping, paging
- `lib/usage/flush.ts` — new, the batch pump
- `lib/usage/{events,ingest,summary,flush}.test.ts` — new
- `lib/usage/stream.integration.test.ts` — new, real Redis under `RUN_REDIS_TESTS=1`
- `workers/usage-flush-loop.ts` — new, scheduling and the enablement gate
- `workers/usage-flush-loop.test.ts` — new, backlog vs. outage scheduling
- `workers/chargebee-webhook-worker.ts` — start the flush loop, drain it on SIGTERM
- `app/api/generate/stream.ts` — one `recordUsageEvent()` after `meterGeneration`
- `app/api/usage/history/route.ts` — new
- `lib/events/types.ts` — `app.usage_ingested`, `app.usage_ingest_failed`
- `.env.example`, `infra/variables.tf`, `infra/locals.tf` — usage config
- `ARCHITECTURE.md` — the usage path

Config went to `container_env`, not `app-secrets.tf` as first planned: the
ingest and summary calls reuse `CHARGEBEE_API_KEY`, so there is no new secret.

## Notes

- Advanced UBB must be enabled on the site before bootstrap stage 6 works:
  Settings > Configure Chargebee > Billing LogIQ > Metered Billing and Advanced
  Usage Based Billing. Live sites need an access request. The stage detects the
  404 and says so rather than failing opaquely.
- Test sites cap ingest at ~50 requests/sec, which a 60s flush is nowhere near.
- A chart of input and output tokens is two summary calls; the endpoint takes
  one `metric` at a time because Chargebee's does.
- `XADD ... MAXLEN ~` bounds the buffer at ~100k entries (~30MB). Trimming
  unacked entries would be silent data loss, so the bound sits far above one
  interval of peak traffic; `usageStreamDepth()` exposes the depth to alarm on.
