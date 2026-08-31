# Replace simulated generation with OpenRouter

Swap the fake generator behind `POST /api/generate` for real inference via
`@openrouter/ai-sdk-provider` (v3) on `ai` v7.

## Layering

```
app/api/generate/route.ts     HTTP: auth, validation, entitlements, events
        |
        v
lib/generate/index.ts         domain: validate + runGeneration -> text & tokens
        |
        v
lib/generate/openrouter.ts    driver: provider instance, API key, usage accounting
        |
        v
                              openrouter.ai
```

The route never touches `@openrouter/ai-sdk-provider`; the domain layer never
reads `OPENROUTER_API_KEY`.

## Enforcement ordering

Simulation was free, so the old route generated first and enforced after. A
paid call inverts the risk: a `basic` subscriber could name `openai/gpt-5-pro`,
we would pay for it, and only then return 402.

`enforceGeneration` splits in two:

| Step                | Checks                          | When            |
| ------------------- | ------------------------------- | --------------- |
| `admitGeneration`   | model tier, rate limit          | before the call |
| `meterGeneration`   | daily tokens, monthly credits   | after the call  |

Metering has to stay on the back edge because only the provider knows the real
output token count. Both steps share `EntitlementGateError`, so the HTTP
contract the client sees is unchanged.

Residual exposure: a subscriber already at their quota ceiling still pays for
one upstream call per request before `meterGeneration` returns 402, bounded by
the per-minute rate limit. Closing it needs a remaining-quota pre-check or the
reserve-and-settle scheme; both are out of scope here.

## Token accounting

The chat model is built with `usage: { include: true }` so OpenRouter returns
the upstream provider's counts. When a provider omits them, generation falls
back to a `length / 4` character estimate so metering never bills zero.

`app.generate_requested` fires before the call and carries the estimate;
`app.generate_completed` carries the settled counts. Every event on a request
shares one `trace_id` minted by the route.

## Model catalog

`config/models.yaml` moves from bare names (`gpt-4o-mini`) to OpenRouter slugs
(`openai/gpt-4o-mini`), verified against `GET /api/v1/models`. Tier shape and
the `*` / `:*` wildcard matching in `lib/models.ts` are untouched — `:*` now
matches OpenRouter's real variant suffixes, e.g. `anthropic/claude-opus-5:batch`.

## Changes

- `config/models.yaml` — OpenRouter slugs
- `lib/models.test.ts` — slug assertions
- `lib/generate/openrouter.ts` — new driver
- `lib/generate/index.ts` — replaces `simulate.ts`
- `lib/generate/index.test.ts` — replaces `simulate.test.ts`, mocks the driver
- `lib/entitlements/gate.ts` — split gate
- `app/api/generate/route.ts` — admit, generate, meter; 502 on upstream failure
- `.env.example` — `OPENROUTER_API_KEY`
- `infra/app-secrets.tf`, `infra/locals.tf`, `infra/README.md` — key reaches the
  deployed task through `pointer-app-secrets`
