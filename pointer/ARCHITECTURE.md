# Pointer — Architecture Overview

This document outlines the high level architecture of the app, including it's tech stack and infrastructure.


## 1. Tech Stack

| Layer | Technology | Role |
| --- | --- | --- |
| Web + API | **Next.js 16** (App Router, standalone build), **React 19** | Renders the UI and hosts all HTTP endpoints |
| Auth | **Better Auth** | Email/password, 2FA, bearer tokens, organizations, admin |
| Billing | **Chargebee** + [@chargebee/better-auth](https://npmx.dev/@chargebee/better-auth) plugin | Customer/subscription lifecycle and webhook sync |
| Primary DB | **PostgreSQL 18** (via `pg` + Kysely) | Users, sessions, orgs, subscription mirror, usage archive |
| Cache + streams | **Redis 8** (`ioredis`) | Idempotency helpers, usage counters, the usage-event buffer, and the live event stream |
| Async transport | **AWS SQS** (+ DLQ), `sqs-consumer` | Buffers Chargebee webhooks for the worker |
| Background jobs | Standalone Node process (`tsx`) | Consumes SQS and applies DB sync |

---

## 2. Component Diagram

```mermaid
flowchart LR
    User(["Browser / User"])
    CB["Chargebee<br/>(billing system of record)"]

    subgraph AWS["AWS (ECS Fargate)"]
        subgraph App["pointer-app (Next.js)"]
            Web["Web UI + Auth<br/>(Better Auth)"]
            WHIn["Webhook endpoint<br/>validate + enqueue"]
            SSE["/api/events/stream<br/>(SSE)"]
        end
        Worker["pointer-worker<br/>SQS consumer +<br/>correctness pipeline<br/>+ usage flush loop"]
    end

    Queue[["SQS queue"]]
    DLQ[["SQS DLQ"]]
    PG[("PostgreSQL<br/>RDS")]
    Redis[("Redis<br/>streams + cache")]

    User -->|"HTTPS (via ALB)"| Web
    Web -->|"create customer / subscription"| CB
    Web --> PG
    Web -->|"publish events"| Redis
    Web -->|"buffer usage events"| Redis
    Web -->|"read usage history"| PG
    SSE -->|"subscribe"| Redis
    User -->|"live flow view"| SSE

    CB -->|"webhook (Basic Auth)"| WHIn
    WHIn -->|"enqueue"| Queue
    Queue -->|"long-poll"| Worker
    Worker -->|"plugin DB-sync hooks"| PG
    Worker -->|"poison / exhausted"| DLQ
    Worker -->|"publish events"| Redis
    Redis -->|"drain buffer"| Worker
    Worker -->|"archive usage events"| PG
    Worker -->|"batch ingest usage"| CB
```

**Reading the diagram**

- **Synchronous path (blue in your head):** the browser hits the app through the ALB.
  Better Auth handles sign-up/sign-in and, on sign-up, calls Chargebee to create a matching
  customer plus an idempotent free subscription. Upgrades and billing-portal actions also go
  straight to Chargebee via the SDK.
- **Asynchronous path:** Chargebee calls back with webhooks. The app endpoint authenticates
  and enqueues them to SQS, then returns `2xx` immediately. The worker picks them up and
  applies changes to Postgres. Once `subscription_created` has established the local
  subscription row, the worker queues a second job to fetch and persist its entitlements.
- **Usage path:** each settled generation is appended to a Redis stream. The worker drains it
  into two sinks in one pass: a weekly-partitioned Postgres table, then Chargebee's batch
  ingest API. Quotas are still enforced locally from Redis counters; Postgres holds the
  history those counters discard at each period reset, and serves the usage page. Chargebee
  remains the billing system of record, but its API quota is a billing budget and is not
  spent on a page a subscriber refreshes several times a day.
- **Observation tap:** every meaningful step emits an event onto a Redis stream. The
  `/admin/flow` page subscribes over Server-Sent Events to animate the system live — it is
  purely for demonstration and never on the critical path.

---

## 3. Core Components

### 3.1 `pointer-app` (Next.js)

The single web/API application. It is responsible for:

- **Authentication & accounts** — Better Auth with the organization plugin. Personal accounts
  bill against the user; Team accounts bill against the organization.
- **Chargebee provisioning** — on user creation a Chargebee customer is created (or reused),
  its ID is stored on the `user` row, and an idempotent free subscription is created. The
  home page waits for the subscription webhook before opening, then uses free-tier defaults
  while the queued entitlement snapshot finishes loading.
- **Webhook ingress** — the Chargebee webhook endpoint validates HTTP Basic Auth, parses the
  payload, and enqueues it to SQS. It intentionally does **no** database work, so a webhook
  storm can never degrade the web tier.
- **Live event stream** — publishes domain events to a Redis stream and exposes them over SSE
  for the `/admin/flow` visualization.

### 3.2 `pointer-worker` (selectable SQS consumer)

The worker owns all webhook-driven database sync and can run as either an ECS service (the
default) or an SQS-triggered Lambda function, selected by Terraform's `worker_runtime`
variable. The runtimes are mutually exclusive and consume the same durable queue. Both call
the same per-message correctness pipeline that the plugin alone can't provide:

```
parse → stale/duplicate guard → dependency pre-check → process
      → verify-after-process → commit versions → ack
```

- **Idempotency without an inbox** — SQS is at-least-once, but the sync hooks are idempotent
  and a `resource_version` guard turns a stale or redelivered event into a no-op.
- **Error handling** — transient/dependency-not-ready errors get an increasing backoff (via
  `ChangeMessageVisibility`) and are left on the queue; after 5 attempts SQS auto-routes them
  to the DLQ. Malformed "poison" messages are sent straight to the DLQ.
- **Scaling** — ECS scales tasks from queue-depth alarms. Lambda uses a bounded SQS event
  source concurrency so its warm connection pools cannot overwhelm PostgreSQL or Redis.
  SQS visibility prevents simultaneous processing; no leader election is required.
- **Lambda batches** — partial batch responses retry only failed records. A cold Lambda loads
  the existing application and database secrets from Secrets Manager before constructing the
  Better Auth processor; warm environments reuse the processor and connection pools.
- **Networking** — Lambda runs in private subnets for RDS/Redis and reaches Chargebee and AWS
  APIs through a NAT gateway. The POC uses one NAT; production should use one per AZ.
- **Entitlement jobs** — after the subscription-created webhook writes the subscription and
  item rows, the same queue receives a job for its entitlement snapshot. Jobs skip the webhook
  pipeline, since there is no additional Chargebee event to order or verify, but reuse the
  backoff and DLQ.
- **Usage flush** — a second loop drains the Redis usage buffer into Postgres and then
  Chargebee, up to 500 events per pass (Chargebee's batch ceiling). Both sinks are fed from
  one pass rather than a second consumer group, because settling an entry deletes it from the
  stream: whichever group acknowledged first would take it away from the other. A failed
  Postgres write abandons the pass without acknowledging anything, since history is the read
  path and a silent gap would be visible to the subscriber. It rides this process rather than
  a service of its own: the work is a periodic drain and this is already a long-running task in the VPC
  with a Redis connection. Redis consumer groups spread entries across however many tasks
  autoscaling creates, so no leader election is needed — the same property SQS provides for
  webhooks. The loop requires the ECS runtime; `lib/usage/flush.ts` is runtime-agnostic so a
  scheduled Lambda could drive it instead.

See [`docs/plans/5-webhook-correctness.md`](docs/plans/5-webhook-correctness.md) for the full rationale.

### 3.3 Data stores

- **PostgreSQL** — the primary store. Better Auth manages the core schema (users, sessions,
  organizations, members) plus the Chargebee plugin's tables and a small
  `chargebee_resource_version` table used for out-of-order protection. Schema changes are
  applied by Better Auth's migration CLI, run as a dedicated one-off task.
  It also holds `usage_event`, the durable usage archive. That table is range-partitioned by
  ISO week so a period's worth of history is a handful of contiguous partitions and ageing
  data can be dropped by detaching one; `pg_cron` provisions the coming fortnight's
  partitions nightly, with a `DEFAULT` partition catching anything it misses. A single
  unique index on `("subscriptionId", "usageTimestamp", "deduplicationId")` does double duty
  — it is the history query's range scan and the conflict target that makes the flush loop's
  at-least-once replay a no-op — so the write path pays for exactly one index. The CLI cannot
  express partitioning, so `lib/usage/partitions.ts` owns that DDL while
  `plugins/usage-plugin.ts` keeps the columns under CLI management.
- **Redis** — hosts the Redis-Streams event bus for the live flow view, the quota and rate
  counters, and the usage-event buffer awaiting its next Chargebee batch. The event bus is a
  best-effort observation tap: if it is down, publishing fails silently and the caller is
  unaffected. The usage buffer is held to a higher bar — it is read through a consumer group
  so an unacknowledged batch survives a worker crash — but it is not as durable as SQS. A node
  loss drops at most one flush interval of events. Production should enable AOF or add a
  replica; the POC runs a single `cache.t4g.micro`.

### 3.4 Chargebee

The external billing **system of record**. The app never treats its local Postgres data as
authoritative for billing state — it mirrors Chargebee via webhooks and reconciles using
resource versions. See [`docs/03-chargebee-source-of-truth.md`](docs/03-chargebee-source-of-truth.md).

---

## 4. Infrastructure

Everything is defined as **Terraform** under [`infra/`](infra/) and runs on **AWS**. The stack
is intentionally lean for a proof-of-concept, with production trade-offs documented in the
infra README.

```mermaid
flowchart TB
    Route53["Route53<br/>pointer.localcblabs.com"] --> ALB["ALB<br/>HTTPS, TLS 1.2+"]
    ALB --> AppSvc["ECS service: pointer-app<br/>Fargate (Next.js :3000)"]
    subgraph ECS["ECS Fargate cluster (pointer-cluster)"]
        AppSvc
        WorkerSvc["ECS service: pointer-worker<br/>queue-depth autoscaling"]
        Migrate["one-off task: pointer-app-migrate"]
    end
    AppSvc --> RDS[("RDS Postgres<br/>encrypted, TLS")]
    WorkerSvc --> RDS
    AppSvc --> SQS[["SQS queue + DLQ"]]
    WorkerSvc --> SQS
    Secrets["Secrets Manager<br/>db + app secrets"] -.-> AppSvc
    Secrets -.-> WorkerSvc
    ECR["ECR: pointer-app"] -.image.-> ECS
```

| Area | What runs |
| --- | --- |
| **Network** | `pointer-vpc` (10.20.0.0/16), Internet Gateway, 2 public subnets across 2 AZs |
| **Edge** | ALB (HTTPS only, HTTP→HTTPS redirect); Route53 alias to `pointer.localcblabs.com`; ACM cert looked up |
| **Compute** | ECS Fargate cluster with `pointer-app` (web), `pointer-worker` (webhook consumer), and a short-lived `pointer-app-migrate` task |
| **Images** | ECR repo `pointer-app`; a slim standalone `:latest` for the app, a `builder` image for worker + migrations |
| **Data** | RDS Postgres (`db.t4g.micro`, single-AZ, encrypted at rest, TLS enforced) |
| **Async** | SQS main queue + DLQ (SSE on both, `maxReceiveCount=5`) |
| **Secrets** | Secrets Manager holds DB credentials and app/Chargebee secrets, injected into tasks at start |
| **Logs** | CloudWatch log groups per service (14-day retention) |

**Deploy shape.** A new image is built and pushed to ECR, Better Auth migrations run as a
one-off Fargate task against the new schema, then the `pointer-app` and `pointer-worker`
services are rolled onto the new image.

**Worker autoscaling.** The worker scales on SQS backlog
(`ApproximateNumberOfMessagesVisible`): scale out when the queue is deep, scale in when it
drains, within configurable min/max bounds — so webhook bursts are absorbed without touching
the web tier.

**Security baseline.** Encryption at rest (RDS/SQS/Secrets/ECR) and in transit (ALB TLS 1.2+,
RDS `force_ssl`), security groups that reference each other rather than open CIDRs, RDS not
publicly reachable, and IAM scoped to specific secret and queue ARNs.

---

## 5. Local Development

`docker-compose.yaml` brings up the full dependency set offline:

- **Postgres 18** on `:5432`, built from [`docker/postgres`](docker/postgres) so it carries
  `pg_cron` (the stock image does not) and loads it with the same settings as the RDS
  parameter group
- **Redis 8** on `:6379`
- **LocalStack** on `:4566` providing SQS, with the webhook queue + DLQ created on startup
  (mirroring `infra/sqs.tf`)

Apply the schema with `pnpm db:migrate:local`, run the app with `next dev`, and the worker
with `pnpm worker:chargebee`. This mirrors the production topology closely enough that the
same code paths — enqueue, consume, sync — are exercised end to end without any AWS account.

The Postgres image moved from the alpine variant to Debian for `pg_cron`, which changes the
collation provider. An existing `postgresql-data` volume should be recreated
(`docker compose down -v postgresql`) rather than reused across that switch.

---

## 6. Where to Go Next

| Topic | Document |
| --- | --- |
| Component boundaries & ports | [`docs/01-architecture.md`](docs/01-architecture.md) |
| Data model | [`docs/02-data-architecture.md`](docs/02-data-architecture.md) |
| Chargebee as source of truth | [`docs/03-chargebee-source-of-truth.md`](docs/03-chargebee-source-of-truth.md) |
| Sequence flows | [`docs/04-sequence-flows.md`](docs/04-sequence-flows.md) |
| Scaling & deployment | [`docs/05-scaling-and-deployment.md`](docs/05-scaling-and-deployment.md) |
| Infrastructure (Terraform) | [`infra/README.md`](infra/README.md) |
