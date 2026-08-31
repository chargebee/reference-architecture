# Stream generation output

Turn `POST /api/generate` from one JSON response into a streamed one, without
losing entitlement enforcement.

## Why this is not a drop-in swap

Metering runs after generation, because only the provider knows the real output
token count. Streaming commits the status line before that number exists, so
`meterGeneration` can no longer turn a quota breach into an HTTP 402, and the
`UsageSnapshot` that drives the client meters can no longer ride in the body.

Policy chosen: **cut the stream and surface an error**. A subscriber who runs
out mid-answer gets the partial text, a terminal error frame, and refreshed
meters — not a silently truncated answer, and not free overage.

## Enforcement, in three moves

```
admitGeneration            before  model tier, rate limit, output token budget
budget watch               during  running estimate vs budget -> abort the call
meterGeneration            after   settle real (or estimated) usage
```

`admitGeneration` now also computes how many output tokens the subscriber can
still pay for:

```
budget = (dailyOutputLimit - outputUsed)
       + (creditsLeft - inputOverageCost) / OUTPUT_CREDIT_MILLI_PER_TOKEN
```

Input tokens are deducted first because they draw on the same credit pool.
`Infinity` limits propagate, so an unlimited plan yields an unlimited budget. A
budget below one token is a 402 *before* the call — which also closes the gap
left open by the previous plan, where a tapped-out subscriber still paid for one
upstream call per request.

During the stream the budget is policed on a running character estimate, since
deltas carry no token counts. Crossing it aborts the upstream call immediately.

## Wire format

NDJSON, one frame per line, `application/x-ndjson`.

| Frame   | Carries                                        |
| ------- | ---------------------------------------------- |
| `delta` | `text` — appended to the answer as it arrives   |
| `done`  | settled `usage` and a fresh `limits` snapshot   |
| `error` | `error`, `message`, `featureId`, `upgradeHint`, `limits` |

Frames were chosen over the AI SDK UI message protocol because `AskPanel` is a
plain `fetch`, not `useChat`; adopting that protocol would mean adding
`@ai-sdk/react` for a single text box.

Pre-flight denials (401, 400, 403, 402, 429, 503) stay plain JSON with a real
status code. Only once the stream opens do failures become `error` frames, and
those always arrive over a 200.

## Layering

```
app/api/generate/route.ts    auth, validation, pre-flight gate, status codes
app/api/generate/stream.ts   the 200 body: budget watch, metering, framing
app/api/generate/frames.ts   wire types, shared with the client via `import type`
lib/generate/index.ts        streamGeneration -> deltas, running estimate, settle
lib/generate/openrouter.ts   unchanged
```

The character-per-token heuristic stays inside `lib/generate`; the route asks
the stream for `streamedTokens()` rather than counting characters itself.

## Notes

- `streamText` does not throw on provider failure; errors surface through
  `onError`. They are captured and rethrown when the caller finishes reading,
  so an upstream fault still becomes a `GenerationError`.
- An aborted call never settles its usage promise, so a cut stream is billed on
  estimates.
- A client disconnect stops the writes but lets metering finish, so usage is
  never lost.
- `x-accel-buffering: no` keeps proxies from buffering the whole body.

## Changes

- `lib/entitlements/gate.ts` — `admitGeneration` returns an output token budget
- `lib/generate/index.ts` — `streamGeneration` replaces `runGeneration`
- `lib/generate/index.test.ts` — streaming, budget estimates, upstream failure
- `app/api/generate/frames.ts` — new
- `app/api/generate/stream.ts` — new
- `app/api/generate/route.ts` — pre-flight only, then hand off to the stream
- `app/_components/ask-panel.tsx` — NDJSON reader, incremental output
