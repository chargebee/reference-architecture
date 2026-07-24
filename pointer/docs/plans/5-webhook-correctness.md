# Chargebee Webhook Correctness: Out-of-order, Idempotency & Ordering

Close the correctness gaps between [`how-to/integrating-chargebee-webhooks.md`](../../../how-to/integrating-chargebee-webhooks.md) and the current implementation. Today the happy path (auth → validate → enqueue to SQS → async process → DLQ config) is in place, but the at-least-once / out-of-order guarantees are not.

## Root cause

All the missing behaviour is normally the plugin's job, but `@chargebee/better-auth@1.2.0` cannot give us these guarantees and we must not patch `node_modules`:

1. **Errors are swallowed.** Every DB-sync hook is wrapped in `try { … } catch (e) { logger.error(e) }` with no rethrow. So `processor.process(event)` essentially never throws, and the worker acks (deletes) the message even when the sync silently failed. The `maxReceiveCount=5 → DLQ` redrive is effectively dead for processing/DB errors.
2. **Missing dependency = silent drop.** `onSubscriptionCreated` logs `No user or organization found…` and `return`s when the referenced customer isn't in our DB yet — the out-of-order case the how-to explicitly calls out. The event is lost, never retried.
3. **No `resource_version` comparison.** Nothing in the plugin or `pointer/` compares `content.<resource>.resource_version`, so a late-arriving older event can overwrite newer state.

**Idempotency, by design, needs no inbox.** We deliberately do *not* add an event-id inbox to deduplicate deliveries — that would add a synchronous DB round-trip to every message and cap throughput. SQS is at-least-once, so duplicates *will* happen, but our operations are idempotent (the plugin's hooks upsert / check entity existence), and the `resource_version` guard (#3) turns a redelivered event into a no-op because its version is no longer greater than what's already stored. A duplicate should therefore be handled without side effects; we don't need a dedicated dedup table to enforce it.

**Strategy:** keep using the plugin for the actual DB writes, but wrap `processor.process()` in the worker with our own pipeline — resource-version guard, dependency pre-check, and post-write verification — plus typed retryable/poison errors that drive real SQS retry/DLQ behaviour. One small Postgres table backs the version store.

## Scope

In scope (the correctness-critical gaps #1–#3 from the review, plus supporting work):

- [ ] `resource_version` staleness guard per resource (also gives duplicate-delivery protection for free)
- [ ] Out-of-order dependency handling via retryable errors (no silent drops)
- [ ] Verify-after-process so swallowed hook errors still trigger retries
- [ ] Retryable-vs-poison classification + increasing backoff + explicit DLQ routing for poison
- [ ] DLQ monitoring (CloudWatch alarm) + a redrive runbook/script

Out of scope: an event-id inbox / dedup table (idempotent operations + version guard cover this), changing the synchronous ingest handler (it already validates Basic Auth, filters event types, enqueues, and returns 2xx/5xx correctly), and any change to `@chargebee/better-auth` itself.

## Data model

One new table, `chargebee_resource_version`, declared as a **Better Auth plugin schema** so the bundled CLI (`@better-auth/cli migrate` / `generate`) creates and maintains it — no bespoke SQL migration script. See [Better Auth › Database › Plugins Schema](https://better-auth.com/docs/concepts/database#plugins-schema).

Register a tiny plugin (`lib/webhook-plugin.ts`) and add it to the `plugins` array in `lib/auth.ts`:

```ts
export const webhookCorrectnessPlugin = {
  id: "webhook-correctness",
  schema: {
    chargebeeResourceVersion: {
      modelName: "chargebee_resource_version",
      fields: {
        // "<resourceType>:<resourceId>", e.g. "customer:cbdemo_alex"
        resourceKey: { type: "string", required: true, unique: true },
        // bigint: Chargebee resource_version is a large ms-based monotonic value
        resourceVersion: { type: "number", required: true, bigint: true },
        updatedAt: { type: "date", required: true, defaultValue: () => new Date() },
      },
    },
  },
} satisfies BetterAuthPlugin;
```

Notes on the generated schema:
- Better Auth adds an `id` text primary key automatically. It can't express a composite PK, so we key upserts off the unique `resourceKey` (`"<resourceType>:<resourceId>"`) rather than a `(resource_type, resource_id)` PK.
- `bigint: true` maps to a Postgres `bigint` column (avoids int32 overflow on `resource_version`).
- The `date` field's function `defaultValue` makes the CLI emit `updatedAt ... DEFAULT CURRENT_TIMESTAMP`.
- Duplicate-delivery protection still falls out for free: a redelivered event carries a version no greater than the stored one, so it is skipped.

- Delivery/migration: nothing extra. The existing migrate task (`infra/migrate.tf` → `npx @better-auth/cli migrate -y`, and `npx @better-auth/cli generate` locally) picks up the new table because it's part of the auth config's plugin schema.

## Code changes

### 1. Error types — `lib/webhook-errors.ts` (new)

```ts
export class RetryableWebhookError extends Error {}   // dependency-not-ready, transient DB/network
export class PoisonWebhookError extends Error {}      // malformed / permanently unprocessable
```

`RetryableWebhookError` → rethrow from the handler so sqs-consumer does **not** delete; SQS redelivers and, after `maxReceiveCount=5`, auto-routes to the DLQ. `PoisonWebhookError` → do not waste retries: emit an event, send the payload to the DLQ explicitly, and ack the main-queue message.

### 2. Version + dependency helpers — `lib/webhook-guards.ts` (new)

Backed by the `pg` pool from `lib/db.ts`.

- `isStale(resourceType, id, incomingVersion)`: read stored version; return true if `incomingVersion <= stored`. Used to skip stale resources *and* duplicate redeliveries.
- `commitVersions(event)`: for each resource in `content` that carries a `resource_version`, upsert keyed on the unique `resourceKey` with `ON CONFLICT ("resourceKey") DO UPDATE SET "resourceVersion" = EXCLUDED."resourceVersion" WHERE EXCLUDED."resourceVersion" > chargebee_resource_version."resourceVersion"` (a fresh `id` is supplied on insert and ignored on conflict).
- `assertDependencies(event)`: for subscription events, verify a customer row exists for `content.customer.id` (query `user`/`organization` by `chargebeeCustomerId`). If missing → `throw new RetryableWebhookError("customer <id> not yet in DB")`.

### 3. Worker rewrite — `workers/chargebee-webhook-worker.ts`

New per-message pipeline inside `handleMessage`:

1. **Parse.** `JSON.parse` failure or missing `event.id` → `throw new PoisonWebhookError(...)`.
2. **Stale / duplicate guard.** If every resource in `content` is stale (`isStale`) → emit `chargebee.webhook_skipped_stale`, return (ack). This is where redelivered duplicates and older out-of-order events both drop out cheaply.
3. **Dependency pre-check.** `assertDependencies(event)` (throws `RetryableWebhookError` when the prerequisite hasn't landed).
4. **Process.** `await processor.process(event)` (plugin DB-sync, as today).
5. **Verify-after-process.** Re-read the entity the event should have produced/updated (e.g. subscription row exists with expected status). Mismatch ⇒ the plugin swallowed an error ⇒ `throw new RetryableWebhookError(...)` so it retries instead of being silently lost.
6. **Commit.** `commitVersions(event)`, emit `chargebee.webhook_processed`, ack.

Error handling wrapper:
- Read `ApproximateReceiveCount` (enable via `attributeNames: ["ApproximateReceiveCount"]` in `Consumer.create`).
- On `RetryableWebhookError`: set an **increasing backoff** with `ChangeMessageVisibilityCommand` — `visibility = min(30 * 2^(receiveCount-1), 900)` (30s → … → 15 min) so dependency-not-ready messages wait progressively longer; then rethrow (no ack).
- On `PoisonWebhookError`: emit `chargebee.webhook_dead_lettered`, `SendMessage` to the DLQ URL, then return (ack the main queue) so poison payloads skip the retry budget entirely.
- On any unknown error: treat as retryable (safer default), rethrow.

New env var: `CHARGEBEE_WEBHOOK_DLQ_URL` (for explicit poison routing) — add to `infra/locals.tf`, `.env.example`, `.env.local`, `docker/localstack/init-sqs.sh` output, and the worker's `requireEnv`.

### 4. Publish side — `lib/webhooks.ts` (minor)

No functional change required for correctness, but capture `resource_version`s in the `chargebee.webhook_received` emit payload so the /flow visualization can show ordering. (Optional.)

## Infra changes

### `infra/sqs.tf`
- Add a CloudWatch alarm on the DLQ: `ApproximateNumberOfMessagesVisible > 0` → SNS topic `pointer-webhook-dlq-alerts` (new). Wire an email/Slack subscription via a `var`.
- Confirm main-queue `message_retention_seconds` (currently 4 days) is comfortably larger than the largest realistic out-of-order gap — it is; document the rationale in a comment. (Optionally raise to match the how-to's "hours-to-days" guidance if desired.)
- Grant the worker's task role `sqs:SendMessage` on the DLQ (for explicit poison routing) and `sqs:ChangeMessageVisibility` on the main queue.

### `infra/scripts/redrive-dlq.sh` (new)
Runbook script using `aws sqs start-message-move-task` (SQS-managed redrive) to move messages from DLQ back to the main queue once a root cause is fixed, plus a `--dry-run` that just prints `ApproximateNumberOfMessages`.

### `docker/localstack/init-sqs.sh`
Already provisions main + DLQ with `maxReceiveCount=5`; add exporting the DLQ URL so local dev mirrors the new `CHARGEBEE_WEBHOOK_DLQ_URL`.

## How each gap is closed

| How-to requirement | Mechanism |
| --- | --- |
| Idempotent processing / duplicate deliveries | Idempotent plugin hooks (upsert / existence checks) + `resource_version` guard makes a redelivered event a no-op — no dedup table needed |
| Tolerate out-of-order dependent events by retrying, not dropping | `assertDependencies` → `RetryableWebhookError` → no-ack → SQS redelivery w/ backoff → DLQ after 5 |
| Don't return 5xx to Chargebee for worker-not-ready | Unchanged: ingest already returns 2xx after enqueue; retries happen queue-side |
| Compare `resource_version`, per resource | `chargebee_resource_version` store + `isStale`/`commitVersions` |
| Distinguish dependency-not-ready from poison | `RetryableWebhookError` vs `PoisonWebhookError`; poison routed straight to DLQ |
| Increasing backoff keyed off delivery count | `ChangeMessageVisibility` using `ApproximateReceiveCount` |
| Retention ≥ out-of-order gap + DLQ policy | Existing 4d/14d retention + `maxReceiveCount=5`; documented |
| DLQ monitored, retained, re-drivable | CloudWatch alarm + `redrive-dlq.sh` |
| Swallowed-error safety net | Verify-after-process re-read ⇒ retry on silent failure |

## Testing

- **Unit**: `isStale` boundaries (equal/lower/higher version); error classification.
- **Integration (LocalStack + Postgres)**:
  - Duplicate delivery of the same event → single DB effect; the second delivery is skipped by the `resource_version` guard, no side effects.
  - `subscription_created` delivered before its customer row → message retried (visible in `ApproximateReceiveCount`), then succeeds once the customer is inserted; never dropped.
  - Out-of-order `subscription_changed` (older `resource_version`) after a newer one → skipped, DB state unchanged.
  - Malformed JSON body → lands in DLQ immediately (not after 5 receives).
  - Simulated transient DB failure during `process()` → message retried (verify-after-process catches the swallow), then succeeds.
- **Manual**: trigger the DLQ alarm; run `redrive-dlq.sh` to move a message back and confirm it processes.

## Rollout

1. Run `@better-auth/cli migrate` (the new table is part of the plugin schema; additive, no backfill needed).
2. Deploy the worker changes; monitor `ApproximateReceiveCount` distribution and DLQ depth.
3. Add the alarm + SNS subscription.
4. Update `how-to/integrating-chargebee-webhooks.md` "Implementation notes" section to point at this implementation, and tick the go-live checklist.

## Open questions

- Verify-after-process needs an event-type → expected-post-state map; for event types where the plugin is intentionally a no-op (e.g. unhandled types forwarded to the bus) we skip verification. Confirm the exact set to verify.
- Preferred DLQ alert channel (email vs Slack via SNS→Lambda/chatbot).
- Whether to raise main-queue retention above 4 days (current value already exceeds realistic out-of-order gaps).
- Events that carry no `resource_version` in `content` (if any) won't benefit from the version-guard's duplicate protection; confirm those event types are safe to reprocess purely via idempotent hooks.
