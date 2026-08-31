# Usage page

Move the usage meters off the ask panel onto `/usage`, and add the time buckets
the meters could never show: 24 hours, 7 days, 30 days, billing period.

## Two sources, kept apart

The page renders both halves of the usage pipeline side by side, because they
answer different questions and only one of them is authoritative.

```
Right now (enforcement)        Redis counters + entitlements
  getUsageSnapshot()           current period only, exact, resets on schedule

Over time (reporting)          Chargebee usage summary
  fetchUsageSummary()          eventually consistent, one flush interval behind
```

Neither is redundant. Redis discards history at every reset, so Chargebee is the
only place a 30-day total exists; Chargebee lags the flush loop, so a quota
decision may never read from it.

## Range → Chargebee query

`window_size` and `timeframe_start/end` are what the API takes, so a range is
translated into those. `lib/usage/summary.ts` already snaps the start to a UTC
calendar boundary, so the bucket edges match their labels.

| Range | `window_size` | `timeframe_start` | Buckets |
| --- | --- | --- | --- |
| 24 hours | `hour` | now − 24h | ~25 |
| 7 days | `day` | now − 7d | ~8 |
| 30 days | `day` | now − 30d | ~31 |
| Billing period | `day` | `subscription.periodStart` | period length |

Billing period falls back to 30 days when the local subscription mirror has no
`periodStart` — a brand new account, or a webhook not yet applied.

## Limits per range

Enforced limits are daily (tokens) or per billing period (credits); a range
total needs something to be read against, so the limit is scaled to the span:

```
input_tokens      inputTokensDaily  × rangeDays
output_tokens     outputTokensDaily × rangeDays
credits_consumed  creditsMonthly    × rangeDays / periodDays
generations       —                 (no entitlement)
```

Only two combinations land on a real enforcement window: `24h` against the daily
token quotas, and `period` against the monthly credits. The rest are a pace
line, and the page says so rather than calling them limits. `Infinity` (an
`unlimited` entitlement) survives the arithmetic untouched.

An allowance of zero is a feature the plan does not grant — free-tier credits,
for instance. The card says so instead of drawing a `0 / 0` meter.

## Server component, not a client fetch

The page reads `lib/usage/*` directly and switches ranges through `?range=`
links. Four metered features means four Chargebee calls per render, run in
parallel, with `loading.tsx` covering the wait. Range state lives in the URL, so
a range is shareable and the browser back button works.

`GET /api/usage/history` is left alone. It takes one metric and an explicit
window, which is the right shape for an API and the wrong one for this page.

A Chargebee failure degrades to a notice on the history section only; the live
quotas come from Redis and still render. `CHARGEBEE_USAGE_INGEST_ENABLED=false`
replaces the section with an explanation, matching what the API returns.

## Changes

- `lib/usage/ranges.ts` — new, range → window/timeframe and scaled allowances
- `lib/usage/ranges.test.ts` — new, bucket math, period fallback, unlimited
- `app/usage/page.tsx` — new, auth, subject, both reads, layout
- `app/usage/layout.tsx` — new, the page shell, kept free of runtime data
- `app/usage/loading.tsx` — new, skeleton while the summary calls resolve
- `app/usage/_components/range-tabs.tsx` — new, `?range=` links
- `app/usage/_components/meter.tsx` — new, the bar moved out of the ask panel
- `app/usage/_components/metric-card.tsx` — new, range total and bucket bars
- `app/usage/_components/live-quotas.tsx` — new, the meters moved off the home page
- `app/_components/ask-panel.tsx` — usage block, `Meter`, `formatLimit` removed
- `app/page.tsx` — `Usage` in the signed-in nav
- `proxy.ts` — `/usage` added to the cookie gate

The ask panel keeps its `/api/usage` fetch: it needs `allowedModels` for the
model picker and `entitlementsPending` for its banner.
