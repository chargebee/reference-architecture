# 04 — Sequence Flows

Major end-to-end flows of the platform. Each diagram shows **synchronous calls** as solid
arrows and **asynchronous events** as dashed arrows. All flows assume the architecture in
[`01-architecture.md`](01-architecture.md) and the entitlement model in
[`07-product-and-entitlements.md`](07-product-and-entitlements.md).

Two ids travel everywhere:

- `user_id` — the authenticated human (JWT `sub`)
- `account_id` — the active billing context (JWT `acc`)

---

## 1. Self-Serve Sign-Up + Personal Account + Free Subscription (PLG)

A user signs up, gets a Personal Account, and a Free subscription is provisioned async — they
can use the product immediately.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CDN as CDN/Edge
    participant GW as API Gateway
    participant ID as Identity
    participant AC as Account
    participant BL as Billing BFF
    participant CB as Chargebee
    participant WH as Webhook Ingestor
    participant Bus as Event Bus
    participant ES as Entitlement Sync
    participant Redis as Redis
    participant PGB as PG: Billing
    participant N as Notification

    U->>CDN: POST /signup {email, password}
    CDN->>GW: forward
    GW->>ID: create user (+ personal account)
    Note over ID: Identity owns user + personal-account creation<br/>(both tables in pg-identity, atomic txn).<br/>Account Service owns only Team/Enterprise lifecycle.
    ID->>ID: argon2id hash
    ID->>ID: BEGIN (pg-identity)<br/>INSERT accounts (type=personal, owner=user_id, plan_tier=free)<br/>INSERT account_members (role=owner)<br/>INSERT users (personal_account_id)<br/>INSERT credentials<br/>INSERT outbox(user.signed_up.v1)<br/>INSERT outbox(account.created.v1)<br/>COMMIT
    ID-->>U: 201 + access/refresh JWTs<br/>(sub=user_id, acc=personal_account_id)
    ID-->>Bus: user.signed_up.v1
    ID-->>Bus: account.created.v1

    par Provision billing for the personal account
        Bus-->>BL: account.created.v1
        BL->>CB: create_customer<br/>(id = account_id, cf_account_id, cf_account_type=personal, email)
        BL->>CB: create_subscription_for_items<br/>(plan = plan-free, plan_quantity = 1,<br/>idempotency_key = account_id)
        CB-->>BL: subscription created
        BL->>PGB: UPSERT cb_customers, cb_subscriptions
        CB-->>WH: webhook subscription_created
    and Welcome email
        Bus-->>N: user.signed_up.v1
        N->>N: send welcome email
    end

    Note over WH,ES: Webhook ingestion + entitlement materialization
    WH->>PGB: INSERT webhook_inbox
    WH-->>Bus: subscription.activated.v1 (account_id)
    Bus-->>ES: deliver
    ES->>CB: fetch item entitlements for plan-free (warm)
    ES->>ES: apply seat multiplication (× 1 here)
    ES->>PGB: UPSERT entitlements_current (7 features)
    ES->>Redis: HSET ent:{account_id}, EXPIRE 24h
    ES-->>Bus: entitlement.updated.v1
```

**Key properties**

- The user is logged in **before** Chargebee provisioning completes — billing is fully async.
- Until entitlements materialise, the Entitlement Service returns the **default Free-tier set** baked in config; the product works immediately.
- `account_id` = `cb_customer_id` keeps the customer-create call naturally idempotent on retry.
- Idempotency keys: `account_id` for customer creation; `(account_id, "free")` for the subscription.

---

## 2. AI Request: Entitlement Check + Token Quota + Rate Limit (Hot Path)

The most frequent flow in the system: a user asks the AI a question. Latency budget for the
*decision*: **p99 < 50 ms** (the LLM call itself dominates total time).

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant GW as API Gateway
    participant PS as Product (Chat)
    participant ENT as Entitlement Service
    participant Redis as Redis
    participant LLM as LLM Provider
    participant UI as Usage Ingest
    participant Bus as Event Bus

    U->>GW: POST /api/chat {model, messages}<br/>Authorization: Bearer <jwt>
    GW->>GW: verify JWT (sub=user_id, acc=account_id)<br/>verify membership (account_membership:{user_id})
    GW->>PS: forward (mTLS, headers: user_id, account_id, trace_id)
    PS->>PS: SET LOCAL app.user_id

    PS->>ENT: POST /entitlements/{account_id}/check<br/>{user_id, features:[f_models,f_input_tokens_daily,f_output_tokens_daily,f_api_rate_per_minute]}
    ENT->>Redis: HMGET ent:{account_id}, GET quota:{account_id}:f_input_tokens:<today>,<br/>GET credits:{account_id}, token-bucket TRY rl:api:{user_id}
    Redis-->>ENT: { f_models: "premium", input_limit: 25e6, used: 12e6,<br/>credits: 5000, rl: ok }
    ENT->>ENT: model in models_for(premium)? input headroom? rate ok?
    ENT-->>PS: { allowed: true, headroom: { input: 13e6, credits: 5000 } }

    alt allowed
        PS->>LLM: call model (streaming)
        LLM-->>PS: tokens stream<br/>{input_tokens=2400, output_tokens=830}
        PS->>UI: POST /usage/events (single)<br/>{event_id, account_id, user_id, model_id, input_tokens, output_tokens, cost_usd, is_overage=false}
        UI->>Redis: SET NX idem:<event_id>
        UI->>Redis: INCRBY quota:{account_id}:f_input_tokens:<today>  by 2400<br/>INCRBY quota:{account_id}:f_output_tokens:<today> by 830
        UI-->>Bus: usage.event.v1
        UI-->>PS: 202
        PS-->>GW: streamed result
    else over input quota AND no credits
        ENT-->>PS: { allowed: false, reason: quota_exceeded,<br/>upgrade: { plan: "max", url } }
        PS-->>GW: 402 + paywall hint
    else rate-limited
        ENT-->>PS: { allowed: false, reason: rate_limited, retry_after_ms: 320 }
        PS-->>GW: 429
    end

    GW-->>U: streamed result | 402 | 429
```

**Notes**

- Entitlement check + quota INCRBY + rate-limit consume happen in **one Redis round-trip** via a Lua script (sub-ms).
- Quota INCRBY is "speculative": if the LLM call fails, the Product Service emits a **negative** `usage.event.v1` with `quantity = -input_tokens` to roll the counter back; the aggregator dedupes via `event_id`.
- The `is_overage` flag (set by Entitlement Service when used > limit and credits debited instead) tags the event so finance can separate plan usage from overage.

---

## 3. Token Overage → Credit Debit → Pack Purchase

When the daily quota is exhausted, requests fall back to the credit balance. When credits run
out, the user is offered a credit pack.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant PS as Product (Chat)
    participant ENT as Entitlement Service
    participant Redis as Redis
    participant Bus as Event Bus
    participant N as Notification

    U->>PS: POST /api/chat
    PS->>ENT: check + consume (input=12000)
    ENT->>Redis: INCRBY quota:{account}:f_input_tokens:<today>  by 12000
    Redis-->>ENT: used=25_010_000 (over the 25M cap by 10k)
    ENT->>ENT: overage_credits = ceil(10_000 / 1000) × 1 credit/1k = 10
    ENT->>Redis: DECRBY credits:{account} by 10
    Redis-->>ENT: balance=4990
    alt balance >= 0
        ENT-->>PS: { allowed: true, drew_from_credits: 10, balance: 4990 }
        PS->>Bus: usage.event.v1 (is_overage=true, credits_debited=10)
    else balance < 0
        ENT->>Redis: INCRBY credits:{account} 10  (rollback)
        ENT-->>PS: { allowed: false, reason: credits_depleted,<br/>buy: { pack: "pack-credits-10k", price: "$80" } }
        PS-->>U: 402 + buy-credits CTA
    end

    par Threshold notifications (debounced)
        ENT->>Redis: SETNX threshold:{account}:credits:80pct  (24h)
        alt newly set
            ENT-->>Bus: usage.threshold_crossed.v1
            Bus-->>N: deliver
            N->>N: send "you've used 80% of your credits" email
        end
    end
```

The credit pack purchase is a separate Billing BFF flow (§6).

---

## 4. Account Switching (User Has Multiple Accounts)

A user belongs to their Personal Account plus a Team Account. They switch context.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant GW as API Gateway
    participant ID as Identity
    participant AC as Account
    participant Redis as Redis

    U->>GW: GET /me/accounts
    GW->>AC: list memberships
    AC-->>GW: [{account_id: a_personal, plan: pro}, {account_id: a_acme, plan: team, role: admin}]
    GW-->>U: account list

    U->>GW: POST /accounts/{a_acme}/switch
    GW->>AC: verify membership (a_acme, user_id) and not removed
    AC-->>GW: ok
    GW->>ID: re-mint access JWT with acc=a_acme
    ID->>Redis: SET sess:<sid> with new active_account_id
    ID-->>U: new access_jwt (acc=a_acme)
```

The frontend keeps a single refresh token; the access token is short-lived (15 min) and
re-minted on switch. All subsequent requests carry `acc=a_acme` and are entitlement-checked
against the Team account's plan.

---

## 5. Create Team Account + Invite + Accept

Bringing teammates into a Team plan.

```mermaid
sequenceDiagram
    autonumber
    participant U as Owner User
    participant GW as API Gateway
    participant AC as Account
    participant BL as Billing BFF
    participant CB as Chargebee
    participant WH as Webhook Ingestor
    participant Bus as Event Bus
    participant ES as Entitlement Sync
    participant Redis as Redis
    participant N as Notification
    participant Inv as Invitee

    U->>GW: POST /accounts {type:team, name:"Acme", initial_seats:5}
    GW->>AC: create team account
    AC->>AC: BEGIN<br/>INSERT accounts (type=team, owner=U)<br/>INSERT account_members (role=owner)<br/>INSERT outbox(account.created.v1)<br/>COMMIT
    AC-->>U: { account_id: a_acme }

    par Provision Chargebee
        Bus-->>BL: account.created.v1 (type=team)
        BL-->>U: present checkout (because team plan is paid)
    end

    U->>GW: POST /billing/checkout-session<br/>{plan_id: plan-team, plan_quantity: 5, account_id: a_acme}
    GW->>BL: forward
    BL->>CB: hosted_pages.checkout_new_for_items<br/>(customer_id=a_acme, item_price=plan-team-USD-Monthly,<br/>quantity=5, idempotency_key)
    CB-->>BL: hosted page url
    BL-->>U: redirect to Chargebee
    U->>CB: pay
    CB-->>WH: subscription_created (plan=plan-team, plan_quantity=5)
    WH-->>Bus: subscription.activated.v1
    Bus-->>ES: deliver
    ES->>ES: resolve entitlements × plan_quantity (5)<br/>=> input_tokens_pool=25M/day, ...
    ES->>Redis: HSET ent:{a_acme}
    ES-->>Bus: entitlement.updated.v1
    Bus-->>AC: subscription.activated.v1
    AC->>AC: UPDATE accounts SET plan_tier='team', seat_count=5

    Note over U,Inv: Invite teammate
    U->>GW: POST /accounts/{a_acme}/invitations {email, role:member}
    GW->>AC: create invitation
    AC->>AC: validate seat headroom: count(active members) < seat_count<br/>INSERT account_invitations (token_hash)<br/>INSERT outbox(account.invitation_sent.v1)
    AC-->>U: invitation created
    Bus-->>N: deliver
    N->>Inv: email with single-use link {token}

    Inv->>GW: GET /invitations/{token}/accept (after signup if needed)
    GW->>AC: accept invitation
    AC->>AC: validate token, expiry, seat headroom<br/>INSERT account_members (role=member)<br/>UPDATE invitations SET status=accepted<br/>INSERT outbox(account.member_added.v1)
    AC->>Redis: DEL account_membership:{invitee_user_id}
    AC-->>Inv: ok; you are a member of a_acme
```

**Properties**

- Seat enforcement is at **invitation acceptance**, not creation, so the owner can pre-issue invites equal to their seat count.
- Adding more seats than `plan_quantity`? Owner first calls `POST /billing/subscriptions/{id}/change` to bump quantity, which increases `f_max_seats` after the webhook lands.
- Removing a member doesn't reclaim a seat from Chargebee billing — seats are paid for whether or not filled, until the next plan change.

---

## 6. Credit Pack Purchase

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant BL as Billing BFF
    participant CB as Chargebee
    participant WH as Webhook Ingestor
    participant Bus as Event Bus
    participant CR as Credit Projector
    participant PGB as PG: Billing
    participant Redis as Redis

    U->>BL: POST /billing/credit-packs/purchase<br/>{account_id, item_id: pack-credits-10k}
    BL->>BL: idempotency: SET NX in Redis<br/>(key = sha256(account|item|nonce))
    BL->>CB: invoices.create_for_charge_items_and_charges<br/>(customer_id=account_id, item_price=pack-credits-10k,<br/>idempotency_key)
    CB-->>BL: invoice (pending) + hosted page url
    BL-->>U: redirect to hosted page
    U->>CB: pay
    CB-->>WH: payment_succeeded for invoice
    WH-->>Bus: invoice.paid.v1 (line_items has pack-credits-10k)
    Bus-->>CR: deliver
    CR->>CR: lookup item -> credits_granted (10000)
    CR->>PGB: INSERT credit_ledger (+10000, reason=pack-credits-10k, expires_at=now+12mo)
    CR->>Redis: INCRBY credits:{account_id} 10000
    CR-->>Bus: credits.deposited.v1
```

The user sees the new balance after the next entitlement check (within seconds).

---

## 7. Subscription Change Webhook → Entitlement Cache Invalidation

A plan change initiated from Chargebee admin or the customer portal (e.g., owner upgrades
Team from 5 to 10 seats).

```mermaid
sequenceDiagram
    autonumber
    participant CB as Chargebee
    participant WH as Webhook Ingestor
    participant Inbox as PG: webhook_inbox
    participant Bus as Event Bus
    participant ES as Entitlement Sync
    participant PGB as PG: Billing
    participant Redis as Redis
    participant LRU as Product LRU caches
    participant AC as Account
    participant N as Notification

    CB->>WH: POST /webhooks/chargebee (subscription_changed: plan_quantity 5 -> 10)
    WH->>WH: validate Basic Auth + extract account_id
    WH->>Inbox: INSERT ON CONFLICT DO NOTHING
    alt new event
        WH-->>Bus: subscription.changed.v1
    end
    WH-->>CB: 200 OK

    Bus-->>ES: deliver
    ES->>CB: fetch subscription + item entitlements + overrides
    ES->>ES: recompute<br/>input_pool = 5_000_000 × 10 = 50_000_000
    ES->>PGB: BEGIN<br/>UPSERT cb_subscriptions (plan_quantity=10)<br/>UPSERT entitlements_current<br/>COMMIT
    ES->>Redis: HSET ent:{account_id} (new pooled values)
    ES->>Redis: PUBLISH ent.invalidate {account_id}
    ES-->>Bus: entitlement.updated.v1

    Bus-->>LRU: subscribers drop account from in-process LRU
    Bus-->>AC: update accounts.seat_count = 10
    Bus-->>N: notify owner of plan change
```

**Convergence target:** webhook receipt → Redis updated within **5 s p99**, end-to-end visible
within **30 s p99** (LRU TTL bounds the worst case).

---

## 8. Login (with Optional Account-Scoped SSO)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant GW as API Gateway
    participant ID as Identity
    participant AC as Account
    participant IdP as External IdP
    participant Redis as Redis

    U->>GW: POST /login {email, password OR sso_initiate}
    GW->>ID: forward
    ID->>AC: lookup account with sso_domain matching email
    alt SSO required (email matches Team/Enterprise sso_domain)
        ID-->>U: 302 to /sso/initiate?account_id=...
        U->>IdP: OIDC dance
        IdP-->>U: code
        U->>ID: POST /sso/callback {code}
        ID->>IdP: exchange code -> identity
        ID->>ID: find or create user record (matching email + verified)
    else password flow
        ID->>ID: argon2id verify
    end

    ID->>AC: list memberships for user
    AC-->>ID: [accounts...]
    ID->>ID: pick default acc (Personal, or last-used)
    ID->>ID: mint access_jwt (sub, acc, exp 15m)
    ID->>ID: mint refresh_jwt (jti, exp 30d)
    ID->>Redis: SET sess + refresh
    ID-->>U: tokens + account list
```

---

## 9. Account Deletion

A user deletes a Team account they own. Distinct from "delete my user" which is owner-driven
on the Personal Account.

```mermaid
sequenceDiagram
    autonumber
    participant U as Owner
    participant GW as API Gateway
    participant AC as Account
    participant BL as Billing BFF
    participant CB as Chargebee
    participant Bus as Event Bus
    participant Members as Member services
    participant N as Notification

    U->>GW: DELETE /accounts/{a_acme} {confirmation}
    GW->>AC: forward
    AC->>AC: BEGIN<br/>UPDATE accounts SET status='deleting', deleted_at=now()<br/>INSERT outbox(account.deletion_requested.v1)<br/>COMMIT
    AC-->>U: 202

    par Cancel subscription
        Bus-->>BL: account.deletion_requested.v1
        BL->>CB: subscription.cancel (end_of_term=false)
        BL->>CB: customer.delete (or anonymize)
    and Notify members
        Bus-->>N: send "team account closed" email to all members
    and Members lose Team context
        Bus-->>Members: account.deletion_requested.v1
        Members->>Members: invalidate JWTs with acc=a_acme on next refresh<br/>fall back to Personal Account context
    end

    Note over AC: After grace window (e.g., 30 days):
    AC->>AC: hard-delete accounts row + memberships
```

Deleting the **user** (Personal Account) follows the deletion flow shown in the previous
revision — it cancels both Personal and any solo-owned Team accounts.

---

## 10. Failure Path: Chargebee Outage During Plan Change

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant BL as Billing BFF
    participant CB as Chargebee
    participant Redis as Redis

    U->>BL: POST /billing/subscriptions/{id}/change {plan: plan-max}
    BL->>Redis: SETNX idem:plan_change:<key>
    BL->>CB: subscription.update_for_items
    CB-->>BL: 503 / timeout
    BL->>BL: classify (retryable?)
    alt retryable
        BL->>CB: retry with same idempotency key
        CB-->>BL: 200 (or retry exhausted)
    else not retryable
        BL-->>U: 503 + "billing temporarily unavailable, no charge made"
    end

    Note over BL,Redis: idempotency key prevents<br/>duplicate plan changes on user retry
```

Every Chargebee mutation in Billing BFF carries an idempotency key derived from
`sha256(account_id|operation|inputs|nonce)` held in Redis 24h. Retries are safe.

---

## 11. End-to-End Tracing

Every flow above carries a **W3C trace context**:

- HTTP headers `traceparent` / `tracestate` between services
- Bus event field `trace_id` (and `span_id` of the producer)
- ClickHouse `trace_id` column on `usage_events` and `product_events`
- Chargebee API calls carry `traceparent` in a custom header (terminates at the boundary)

This enables a single trace view for "user clicked upgrade → paid → entitlement updated →
first AI request after upgrade succeeded with the new model" — the most-asked support
question in PLG products.
