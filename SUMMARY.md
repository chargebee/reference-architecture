# Summary

This repository is a documentation-only reference architecture for a production-grade, product-led-growth SaaS platform at roughly 100M end-user accounts. The product shape is a Cursor-class AI coding and productivity assistant with self-serve individual plans, multi-seat Team and Enterprise accounts, usage metering, credit packs, and entitlement-driven feature access.

The central business rule is that Chargebee is the source of truth for plans, subscriptions, item entitlements, invoices, credit notes, and billing events. The platform keeps local materialized read models and Redis caches so request-time paths never call Chargebee.

## High-Level Goals

The architecture is designed to satisfy several goals at once:

- Scale to approximately 100M users, about 40M DAU, 150k-300k peak app RPS, 30k-60k peak usage-event RPS, and billions of usage events per day.
- Keep freemium economics viable by making the Free tier cheap to serve: Redis-backed entitlements, async usage metering, ClickHouse analytics, and no hot-path billing calls.
- Support PLG workflows: instant sign-up, an invisible Personal Account for every user, hosted checkout upgrades, real-time entitlement changes, Team invitations, SSO, and Enterprise overrides.
- Preserve strong service boundaries: services own their data, cross-service integration goes through APIs or versioned events, and producers/consumers use outbox/inbox idempotency.
- Keep each tier independently scalable: stateless services scale on RPS/CPU, product data scales by PostgreSQL sharding, Redis scales by key-space clustering, ClickHouse scales by shards/replicas, and the event bus scales by partitions.

## Architecture Overview

The system is organized as a layered, service-oriented architecture with an event-driven async plane:

1. Edge: CDN, WAF, regional load balancer, and API Gateway.
2. Synchronous application services: Identity, Account, Product, Entitlement, Usage Ingest, Billing BFF, Analytics, and Notification.
3. Async plane: Kafka-class event bus plus workers for Chargebee webhooks, usage aggregation, entitlement sync, credit projection, read-model projection, and outbox relay.
4. Data plane: PostgreSQL, Redis, ClickHouse, and object storage.
5. External systems: Chargebee, LLM providers, email provider, and external IdPs.

Two identifiers appear everywhere:

- `user_id`: the auth identity and product-data partition key.
- `account_id`: the billing subject, active account context, entitlement partition key, and 1:1 Chargebee customer.

Every authenticated request carries both identifiers in JWT claims (`sub`, `acc`). Product data is owned by the user and partitioned by `user_id`; billing, quotas, entitlements, memberships, and plan state are account-scoped and partitioned by `account_id`.

The recommended implementation style inside each service is Clean/Hexagonal Architecture: domain logic depends on ports, while adapters handle PostgreSQL, Redis, Chargebee SDK calls, event bus publishing, and HTTP/gRPC transport.

## Identity, Accounts, and Tiers

The platform distinguishes users from accounts:

- A User is one human identity.
- An Account is the billing subject and maps 1:1 to a Chargebee customer.
- Every user gets exactly one Personal Account at sign-up.
- Free, Pro, and Max plans live on Personal Accounts.
- Team and Enterprise plans live on separate multi-member accounts.
- A user can belong to multiple accounts and switch active context by minting a new access token with a different `acc` claim.

The product tiers are:

- Free: $0, one seat, trial/onboarding use case.
- Pro: $20/month, one seat, solo professional.
- Max: $100/month, one seat, heavy individual usage.
- Team: $30/seat/month, minimum two seats, pooled team quotas.
- Enterprise: contract pricing, unlimited/customized entitlements, SSO, and overrides.

Seven entitlements define the product surface: daily input tokens, daily output tokens, monthly credits, API requests per minute, max seats, SSO access, and available model tier. Team token and credit budgets are per-seat values that are multiplied by `subscription.plan_quantity` into account-pooled caps. API rate limits remain per user.

## Major Components

Identity Service owns users, credentials, MFA, sessions, profile data, and shard-map access. It creates the user and their Personal Account atomically at sign-up and issues JWTs.

Account Service owns Team/Enterprise account lifecycle, memberships, roles, invitations, account switching, and seat enforcement. Account membership is checked at the gateway on every request.

Product Services implement the AI product domains such as chat, code, completions, agents, and integrations. They store product state in sharded PostgreSQL by `user_id`, call the Entitlement Service before expensive actions, emit usage events, and call LLM providers only after authorization.

Entitlement Service answers sub-millisecond allow/deny decisions. It reads Redis first, falls back to `pg-billing.entitlements_current`, and never calls Chargebee on the hot path. It combines entitlement checks, quota counters, rate limiting, and credit consumption.

Usage Ingest Service accepts usage events from Product Services, deduplicates by `event_id`, increments Redis quota counters, and publishes `usage.event.v1` to the bus. It avoids OLTP writes on the request path.

Billing BFF is the only synchronous application service allowed to mutate Chargebee. It creates checkout sessions, portal sessions, subscription changes, and credit-pack purchases using idempotency keys.

Chargebee Webhook Ingestor is the only public receiver for Chargebee webhooks. It validates Basic Auth, stores raw payloads in `webhook_inbox`, deduplicates by Chargebee event ID, normalizes events, and publishes them to the bus.

Usage Aggregator consumes usage events, writes raw and rolled-up usage into ClickHouse, and pushes incremental metered usage to Chargebee for Enterprise or future usage-priced tiers.

Entitlement Sync Worker consumes billing and entitlement events, resolves the Chargebee plan/item/override graph into flat account-keyed entitlements, writes `entitlements_current`, and refreshes Redis `ent:{account_id}`.

Credit Ledger Projector consumes invoice and overage usage events, writes append-only credit ledger entries, and updates Redis `credits:{account_id}`. The ledger is authoritative; Redis is a cache.

Analytics and Notification are read/fan-out services. Analytics reads ClickHouse and billing dimensions for dashboards and finance reports. Notification reacts to domain events for email, in-app notifications, and outbound webhooks.

## Data Architecture

PostgreSQL is split into three logical clusters:

- `pg-identity`: users, credentials, MFA, accounts, memberships, invitations, and the 1024-row logical shard map.
- `pg-product`: sharded by `user_id`, initially modeled as 32 physical shards mapped from 1024 logical shards.
- `pg-billing`: Chargebee materialized read models, entitlement current-state, credit ledger, webhook inbox, billing outbox, and usage push state.

Product tables must put `user_id` first, index by `user_id`, and enable Row-Level Security using `SET LOCAL app.user_id`. Product data remains user-owned even when account context changes.

Redis is split by concern: sessions, entitlements and credit balance, rate limits and quotas, idempotency keys, and generic caches. Account-scoped keys are hash-tagged with `{account_id}`; user-scoped keys are keyed by `user_id`.

ClickHouse stores high-volume usage and product analytics. Raw usage events are append-only, partitioned by date, ordered by account/user/feature/time, retained for 13 months, and rolled up into 1-minute, 1-hour, and 1-day aggregates. It is never on the synchronous request path.

Cross-store consistency is achieved through transactional outbox, consumer inbox/idempotency, deduplication by event ID, scheduled reconcilers, and bounded convergence targets. Chargebee-to-local drift is detected by hourly subscription reconciliation, daily entitlement reconciliation, and nightly finance reconciliation.

## Core Runtime Flows

Sign-up creates the user, Personal Account, account membership, credentials, and outbox events in one `pg-identity` transaction. Billing provisioning then happens asynchronously: Billing BFF creates a Chargebee customer and Free subscription, webhooks arrive, entitlements are materialized, and Redis is refreshed. Until this completes, the product uses baked-in Free-tier defaults.

An AI request goes through JWT verification, account membership verification, product shard routing, entitlement/rate/quota checks, the LLM call, usage event emission, Redis quota increments, and async ingestion to ClickHouse and downstream projectors.

Plan changes and checkout flows are initiated through Billing BFF and Chargebee Hosted Checkout/Portal. The visible platform state changes when Chargebee webhooks are ingested and entitlement sync updates Redis. The target convergence for paid entitlement changes is seconds, with user-visible completion within tens of seconds.

Team workflows create a separate account, subscribe it to a seat-based Team plan, materialize pooled quotas by multiplying per-seat entitlements, and enforce seat count when invitations are accepted.

Overage handling first consumes plan quota, then purchased or plan-granted credits, then returns a 402-style paywall response with upgrade or credit-pack purchase options. Credit packs are one-time Chargebee charges that become usable only after a paid invoice event deposits credits into the ledger.

## Deployment, Scaling, and Operations

The target runtime is Kubernetes across three or more AZs, with service mesh mTLS, separate namespaces for apps and workers, managed PostgreSQL and Redis, ClickHouse, a Kafka-class bus, and object storage. Stateless tiers are active-active by region; stateful tiers start active-passive with home-region routing for product data.

Autoscaling is component-specific: APIs scale by RPS/CPU, entitlement by read QPS and Redis latency, usage ingest by ingress RPS and queue depth, aggregators/workers by consumer lag, and stateful systems by planned capacity triggers. Product data scales horizontally through shard splits without rehashing users, by remapping logical shards to new physical shards.

Release guidance assumes semver container images with git SHAs, canary or blue/green rollouts, online expand-migrate-contract database changes, feature flags keyed by `user_id`, DLQs for all consumers, and replay tooling for operational recovery.

Observability is mandatory: structured JSON logs, RED/USE metrics, W3C trace context, trace IDs on bus events and ClickHouse rows, critical dashboards for API health, entitlements, Chargebee, usage pipeline, PostgreSQL, and noisy-neighbor users. Important SLOs include 99.95% public API availability, p99 entitlement checks below 5 ms, AI request decisions below 50 ms, webhook acknowledgements below 200 ms, usage-to-ClickHouse visibility below 60 seconds, and finance drift below 0.1%.

Security relies on OAuth2/OIDC for users, mTLS between services, short-lived service identities, PostgreSQL RLS, Redis and bus ACLs, encrypted databases and backups, application-layer encryption for PII, no local payment data storage, webhook Basic Auth plus allowlists, idempotency keys, signed outbound webhooks, bot mitigation for free-tier abuse, SBOM/image signing, and per-service deletion handlers for GDPR-style workflows.

## Notable Specifics and Gaps

The repository currently contains documentation only: `README.md` and seven docs under `docs/`. There is no executable application code, OpenAPI spec, event schema registry, infrastructure-as-code, CI pipeline, tests, or generated Chargebee bootstrap script checked in.

The docs are largely consistent, but a few details should be clarified before implementation:

- `pg-billing` write ownership is described both as worker-only read-model projection and as writable by Billing BFF during provisioning. Decide whether Billing BFF may optimistically upsert billing read models or whether all read-model writes must come only from webhooks/projectors.
- Identity is explicitly allowed to create the Personal Account row atomically at sign-up, but one data-store matrix note says Identity does not write `accounts`. The exception should be reflected everywhere.
- The credit-pack purchase flow names different Chargebee invoice APIs in different docs. Pick one canonical operation or document them as equivalent SDK/API variants.
- A referenced `config/models.yaml` is illustrative only and is not present in the repo.

Overall, the architecture prioritizes hot-path speed, billing correctness, service ownership, and operational scalability. Chargebee remains authoritative for commercial state, while Redis/PostgreSQL/ClickHouse provide fast local decisions, durable projections, and analytical visibility at large scale.
