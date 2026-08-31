# Admin route split + chat-style home page

## Current state (confirmed by reading the code)

- `[app/dashboard/page.tsx](app/dashboard/page.tsx)` is reachable by any signed-in user. It gates on subscription (redirects to `/choose-plan`, or shows `AccountProvisioning` when `?provisioning=1`), then renders `SubscriptionCard`, `GenerateDemo`, account stats, and a "Tools" link to `/flow`.
- `[app/flow/page.tsx](app/flow/page.tsx)` is already admin-only (`isAdminRequest` from `[lib/admin.ts](lib/admin.ts)`, which checks Better Auth's `admin` plugin permissions / `ADMIN_USER_IDS`). Non-admins get bounced to `/dashboard`. This is the "related route" that moves with the dashboard.
- `[proxy.ts](proxy.ts)` only checks cookie presence and matches `/dashboard/:path*`, `/flow/:path*`, `/choose-plan`. Real session/permission checks happen in the page/layout (per the existing comment about DB re-verification).
- `/dashboard` and `/flow` are referenced from: `[app/page.tsx](app/page.tsx)`, `[app/(auth)/sign-in/page.tsx](app/(auth)/sign-in/page.tsx)`, `[app/(auth)/sign-up/page.tsx](app/(auth)/sign-up/page.tsx)`, `[app/choose-plan/_components/plan-picker.tsx](app/choose-plan/_components/plan-picker.tsx)`, `[app/api/entitlements/checkout-complete/route.ts](app/api/entitlements/checkout-complete/route.ts)`.

## Decisions (confirmed with user)

- Root page usage/plan info stays **compact**: keep the tier badge + usage meters that already live inside `generate-demo.tsx`, plus a small "Manage plan" link to `/choose-plan`. No full `SubscriptionCard` on `/`.
- Chat experience stays **single-shot** (one prompt -> one output, no history), just restyled to feel like a chat home screen. No multi-turn thread.

## 1. Admin area: `/admin` (restricted)

Create `[app/admin/layout.tsx](app/admin/layout.tsx)` to centralize the gating for every admin route (page-level checks become redundant/defensive only):

```tsx
export default async function AdminLayout({ children }) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in?from=/admin");
  if (!(await isAdminRequest(requestHeaders))) redirect("/");
  return <>{children}</>;
}
```

Moves:
- `app/dashboard/page.tsx` -> `app/admin/page.tsx`. Drop the subscription-gate/`AccountProvisioning` redirect and the `GenerateDemo` section (both move to `/`, see below). Keep the session stat grid and the "Tools" card, but point it at `/admin/flow`. Render `SubscriptionCard` if a subscription exists, else a simple "No active subscription" line (admin oversight shouldn't force the consumer onboarding flow).
- `app/dashboard/_components/subscription-card.tsx` -> `app/admin/_components/subscription-card.tsx` (unchanged).
- `app/flow/page.tsx` -> `app/admin/flow/page.tsx`; drop its now-redundant `isAdminRequest` check (layout handles it), keep the session fetch for the header email display.
- `app/flow/_components/*` -> `app/admin/flow/_components/*`, `app/flow/_lib/*` -> `app/admin/flow/_lib/*` (unchanged; all imports are relative so the move is mechanical).
- Delete the now-empty `app/dashboard/` and `app/flow/` directories.

Update `[proxy.ts](proxy.ts)` matcher:

```ts
matcher: ["/admin/:path*", "/choose-plan"],
```

## 2. Root page (`/`) becomes the logged-in home

Rewrite `[app/page.tsx](app/page.tsx)` to branch on session, porting the subscription/provisioning gate that used to live in the dashboard page:

- **Logged out:** unchanged marketing hero + pricing grid (as today).
- **Logged in:**
  - No active subscription -> same logic as old dashboard: show `AccountProvisioning` when `?provisioning=1`, else `redirect("/choose-plan")`.
  - Otherwise -> render a slim header (logo, "Manage plan" -> `/choose-plan`, "Admin" link only if `isAdminRequest`, `SignOutButton`) followed by the new `AskPanel`.
- Needs `searchParams: Promise<{ provisioning?: string | string[] }>` like the old dashboard page had.

## 3. New shared components under `app/_components/`

- `app/dashboard/_components/generate-demo.tsx` -> `app/_components/ask-panel.tsx`, component renamed `GenerateDemo` -> `AskPanel`. Keep all existing logic (usage polling, entitlement gating, error/upgrade-hint handling, tier badge, meters) — only restyle the JSX shell to read as a chat home:
  - Centered, larger composer (rounded textarea + model select + send button) instead of the current form-in-a-card layout.
  - A friendly heading above the composer (e.g. "What can Pointer help with?").
  - Output renders below as a response card once generated.
  - Tier badge + usage meters stay, moved lower/styled smaller so they read as secondary info under the composer (fulfilling the "compact" decision) instead of a prominent card header.
- `app/dashboard/_components/account-provisioning.tsx` -> `app/_components/account-provisioning.tsx`; change its poll-success redirect from `router.replace("/dashboard")` to `router.replace("/")`.

## 4. Fix up remaining `/dashboard` references

- `[app/(auth)/sign-in/page.tsx](app/(auth)/sign-in/page.tsx)`: default `callbackUrl` `"/dashboard"` -> `"/"`.
- `[app/(auth)/sign-up/page.tsx](app/(auth)/sign-up/page.tsx)`: both `callbackURL`/`router.push` calls `"/dashboard?provisioning=1"` -> `"/?provisioning=1"`.
- `[app/choose-plan/_components/plan-picker.tsx](app/choose-plan/_components/plan-picker.tsx)`: `successUrl` (`%2Fdashboard` -> `%2F`), `cancelUrl` (`"/dashboard"` -> `"/"`), and the "Back to dashboard" link -> `"/"`.
- `[app/api/entitlements/checkout-complete/route.ts](app/api/entitlements/checkout-complete/route.ts)`: `safeCallback` fallback and the unauthenticated sign-in redirect (`from=/dashboard`) -> `/`.
- `[app/page.tsx](app/page.tsx)` pricing grid's `href={session ? "/dashboard" : "/sign-up"}` only remains in the logged-out branch, so no change needed there beyond the rewrite in step 2.
- `[ARCHITECTURE.md](ARCHITECTURE.md)`: small wording fixes (`/flow` -> `/admin/flow`, "dashboard" -> "home page") so the doc stays accurate.

## 5. Legacy URL redirects (added on review)

Renaming `/dashboard` breaks two things that outlive a deploy: bookmarked URLs, and Chargebee hosted-page checkouts started before the change, which carry `successUrl=/api/entitlements/checkout-complete?callbackURL=%2Fdashboard`. `safeCallback` in [app/api/entitlements/checkout-complete/route.ts](app/api/entitlements/checkout-complete/route.ts) only validates the leading `/`, so a stale callback would land the customer on a 404 straight after paying.

Add to [next.config.ts](next.config.ts):

```ts
async redirects() {
  return [
    { source: "/dashboard", destination: "/", permanent: false },
    { source: "/flow", destination: "/admin/flow", permanent: false },
  ];
}
```

## Review notes (second pass)

Checked against the bundled Next.js 16 docs (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/`), since this version differs from older App Router conventions:

- Async layouts calling `redirect()` are supported, so the gating layout in step 1 is valid.
- `searchParams` is a promise (`v15.0.0-RC` onward) — the existing dashboard page already does this correctly, so the root page port is a straight copy.
- Next 16 generates global `PageProps<'/'>` and `LayoutProps<'/admin'>` helpers during `next dev`/`next build`. Use them instead of hand-written prop types for the new layout and the rewritten root page.

Accepted trade-offs (no action, noted so they are deliberate):

- Admin requests resolve the session twice (once in the layout for gating, once in the page for display data). It is a cheap session lookup; wrap `getSession` in React `cache()` later if it ever shows up in traces.
- A signed-out non-admin who opens `/admin` goes to `/sign-in?from=/admin`, signs in, gets pushed to `/admin`, then bounced to `/` by the layout. One extra hop, no loop.
- Rendering the "Admin" link on `/` costs one `userHasPermission` check per logged-in root render.

Per [AGENTS.md](AGENTS.md) ("Save all plans to `plans` directory for auditing"), copy this plan to `pointer/docs/plans/admin-route-split-chat-home.md` as part of the change. That directory exists but is currently empty.

## Verification

- `npm run lint`
- `npm run build` (also regenerates the typed route helpers, so it catches any stale `/dashboard` route literal)
- Manual: signed-out `/` shows marketing; signed-in `/` shows the composer; non-admin `/admin` bounces to `/`; admin sees `/admin` and `/admin/flow`; `/dashboard` and `/flow` redirect.

## Out of scope

- The `/api/events/*` SSE routes used by the flow canvas only check session presence today, not admin status; leaving that as-is since it wasn't part of the request.
- No changes to entitlement/usage backend logic — purely routing + UI.

## Todos

## Follow-up: `@chargebee/entitlements` migration

The production build initially failed on `@chargebee/openfeature/cache`, unrelated to the routing
work. The adapter package was rewritten to extract all framework-agnostic logic into a new
`@chargebee/entitlements` package, removing the `/cache` and `/nextjs` subpaths. Migration applied:

- Added `@chargebee/entitlements` (`file:` link to the sibling monorepo) to
  [package.json](package.json). `@chargebee/openfeature` declares it as `workspace:*`, which cannot
  resolve when consumed from outside its own monorepo, so
  [pnpm-workspace.yaml](pnpm-workspace.yaml) carries a matching `overrides` entry.
- [lib/entitlements/provider.ts](lib/entitlements/provider.ts): `createRedisEntitlementsCache` now
  comes from `@chargebee/entitlements/cache`. The provider no longer owns snapshot logic, so the
  options build a `ChargebeeEntitlements` client (exported as `entitlements`) which is handed to
  `ChargebeeEntitlementsProvider` as `{ entitlements }`.
- [lib/entitlements/sync.ts](lib/entitlements/sync.ts): `refreshSnapshot` / `deleteSnapshot` moved
  off the provider onto the client, so webhook syncs call `entitlements.*` directly.
- [lib/entitlements/postgres-store.ts](lib/entitlements/postgres-store.ts): `EntitlementsStorage`
  and the domain types now import from `@chargebee/entitlements`.

The option names and the `refreshSnapshot` / `deleteSnapshot` signatures were unchanged, so no
behavior moved. The upstream default cache namespace changed to `chargebee:entitlements:v1`, but
Pointer passes `cacheNamespace: "pointer:entitlements:v1"` explicitly, so cached keys are unaffected.
