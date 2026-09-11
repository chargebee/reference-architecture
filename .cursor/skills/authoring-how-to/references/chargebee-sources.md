# Chargebee sources

These guides are read by people who will build against them, so a wrong field name or a stale limit is worse than no guide. Verify every Chargebee-specific claim against the live documentation while drafting.

## Contents

- [Which site for which question](#which-site-for-which-question)
- [Research procedure](#research-procedure)
- [Verified entry points](#verified-entry-points)
- [Facts that must never be written from memory](#facts-that-must-never-be-written-from-memory)
- [Product version traps](#product-version-traps)
- [Tooling that speeds up research](#tooling-that-speeds-up-research)

## Which site for which question

| Question | Site |
| --- | --- |
| What does this endpoint accept and return? What are the resource attributes, enums, and event types? | [apidocs.chargebee.com](https://apidocs.chargebee.com/docs/api) |
| How does the product behave? What does this setting do in the dashboard? How do these objects relate? | [chargebee.com/docs](https://www.chargebee.com/docs/billing/2.0/getting-started/object-relationship) |

When product behavior and API reference appear to disagree, cite the API reference for the contract and the product docs for the behavior, and say which is which.

## Research procedure

1. Search the relevant site for the topic. The docs URL scheme is `https://www.chargebee.com/docs/billing/2.0/<section>/<page>`; the API reference is `https://apidocs.chargebee.com/docs/api/<resource>`.
2. Read the page rather than the search snippet. Snippets routinely drop the qualifier that matters.
3. **Confirm the URL resolves before citing it.** Documentation pages get reorganized, and a plausible-looking path is often a 404:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -L "https://apidocs.chargebee.com/docs/api/<resource>"
```

The validator's `--external` flag checks every outbound link in a finished guide.

4. Link to the specific section or anchor that supports the claim, not to the section landing page. The webhook guide links straight to the event object's out-of-order delivery anchor, which is what makes that claim checkable.
5. Cross-check against `pointer/`. If the code contradicts the docs, the code is probably behind — investigate before documenting either.

## Verified entry points

Confirmed reachable at the time of writing. Re-check before citing.

**API reference**

- Getting started, authentication, pagination, error model — `https://apidocs.chargebee.com/docs/api`
- Events and event types — `https://apidocs.chargebee.com/docs/api/events`
- Event object, including out-of-order delivery — `https://apidocs.chargebee.com/docs/api/events/event-object`
- Webhooks — `https://apidocs.chargebee.com/docs/api/webhooks`
- Idempotency — `https://apidocs.chargebee.com/docs/api/idempotency`
- Error handling and `api_error_code` — `https://apidocs.chargebee.com/docs/api/error-handling`
- Customers — `https://apidocs.chargebee.com/docs/api/customers`
- Subscriptions — `https://apidocs.chargebee.com/docs/api/subscriptions`
- Invoices — `https://apidocs.chargebee.com/docs/api/invoices`
- Hosted pages — `https://apidocs.chargebee.com/docs/api/hosted_pages`
- Payment intents — `https://apidocs.chargebee.com/docs/api/payment_intents`
- Usages — `https://apidocs.chargebee.com/docs/api/usages`
- Entitlements — `https://apidocs.chargebee.com/docs/api/entitlements`

**Product documentation**

- Object relationship model — `https://www.chargebee.com/docs/billing/2.0/getting-started/object-relationship`
- Product catalog — `https://www.chargebee.com/docs/billing/2.0/product-catalog/product-catalog`
- Subscriptions — `https://www.chargebee.com/docs/billing/2.0/subscriptions/subscriptions`
- Invoices and credit notes — `https://www.chargebee.com/docs/billing/2.0/invoices-credit-notes-and-quotes/invoice-overview`
- Entitlements — `https://www.chargebee.com/docs/billing/2.0/entitlements/entitlements`
- Tax — `https://www.chargebee.com/docs/billing/2.0/taxes/tax-overview`

For anything not listed, search the site and verify the URL. Do not extrapolate a path from the pattern.

## Facts that must never be written from memory

- Event type names and the exact set of resources inside `content` for a given event.
- Attribute names, nesting, and enum values on any resource.
- Which parameters an endpoint accepts and which are required.
- Retry schedules, rate limits, page sizes, expiry windows, and any other number.
- Whether a feature is generally available, gated, or plan-dependent.
- Anything about a specific payment gateway's behavior.

Stable enough to rely on, and still worth linking:

- The API is REST over HTTPS at `https://{site}.chargebee.com/api/v2/`, authenticated with HTTP Basic using the API key as the username and an empty password.
- Timestamps are Unix epoch seconds.
- Single resources come back enveloped (`{"customer": {...}}`); lists come back as `{"list": [...]}` with `next_offset` for pagination.
- API keys are per-environment: a test-site key is not a live-site key.
- Webhook events are delivered at-least-once with no ordering guarantee, and `resource_version` is the tiebreaker for staleness.

## Product version traps

- Documentation paths carry the product version (`/docs/billing/2.0/`). Confirm you are reading 2.0 and not an older page surfaced by a search engine.
- Product Catalog exists in two versions. The newer model uses items and item prices; the older uses plans and addons. Which one applies changes the API calls, the event payloads, and the local schema. State which version a guide assumes.
- A Chargebee site can run in test or live mode with separate configuration, keys, and webhook endpoints. Guides should say which mode a step applies to.
- Chargebee sells more than Billing. If a topic touches Retention, Revenue Recognition, or Receivables, name the product explicitly instead of writing "Chargebee".

## Tooling that speeds up research

- API reference pages carry a **Copy for LLM** control that yields the page as clean markdown.
- The full API is published as an OpenAPI 3.0 document, which is the fastest way to confirm a parameter list exhaustively.
- Chargebee publishes an MCP server and official agent skills (`npx skills add chargebee/ai`). If either is available in the session, prefer it over scraping pages.
- **Time Machine** on a test site simulates time-based billing events. Mention it when a guide's testing scenarios depend on renewals, trial expiry, or dunning cycles.
