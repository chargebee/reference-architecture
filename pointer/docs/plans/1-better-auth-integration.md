# Better Auth Integration Plan

Integrate [Better Auth](https://better-auth.com/docs) into the Next.js app at [src/](../src/), using the `pg` driver and Kysely (the app-wide ORM choice).

## Stack confirmed

- **Framework:** Next.js 16.2.6 (App Router), React 19, Tailwind 4, pnpm
- **Database:** PostgreSQL 16 (already in [docker-compose.yaml](../docker-compose.yaml)) via `pg` driver
- **ORM:** Kysely (app-wide). Better Auth uses its built-in Kysely adapter, so no Prisma/Drizzle.
- **Auth methods:** Email & password only (to start)
- **Email sender:** Mock (`console.log`) for now
- **UI:** Minimal styled auth pages
- **Plugins enabled:** `organization`, `admin`, `twoFactor`, `bearer`, plus email verification + password reset

## Pre-flight reads (Next.js 16 caveat)

Per [src/AGENTS.md](../src/AGENTS.md), Next.js 16 has breaking changes. Before writing code, consult:

- `src/node_modules/next/dist/docs/` for route handler conventions, `middleware` API, and any async API changes
- `src/node_modules/better-auth/dist` to confirm the `pg.Pool` adapter signature and `toNextJsHandler` export

## Files to add (under [src/](../src/))

| File | Purpose |
|---|---|
| `src/lib/db.ts` | Shared `pg.Pool` + Kysely instance for the whole app |
| `src/lib/auth.ts` | Better Auth server config: pg pool, email/password, plugins, `nextCookies()`, mock email senders |
| `src/lib/auth-client.ts` | `createAuthClient` from `better-auth/react` with `organizationClient`, `adminClient`, `twoFactorClient` |
| `src/app/api/auth/[...all]/route.ts` | `toNextJsHandler(auth)` exporting `{ GET, POST }` |
| `src/app/(auth)/layout.tsx` | Minimal centered layout for the auth route group |
| `src/app/(auth)/sign-in/page.tsx` | Email/password sign-in form |
| `src/app/(auth)/sign-up/page.tsx` | Email/password sign-up form |
| `src/app/(auth)/forgot-password/page.tsx` | Request password reset link |
| `src/app/(auth)/reset-password/page.tsx` | Set a new password (reads token from query) |
| `src/app/(auth)/verify-email/page.tsx` | Verification status / resend |
| `src/app/(auth)/two-factor/page.tsx` | TOTP challenge during sign-in |
| `src/middleware.ts` | Redirect unauthenticated requests on protected paths |
| `src/.env.example` | Documents required env vars |

## Dependencies to install

```bash
cd src
pnpm add better-auth pg kysely
pnpm add -D @types/pg
```

## Environment variables (`src/.env.local`)

```env
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/reference_architecture
```

`src/.env.example` will document the same keys without secrets.

## Server config sketch ([src/lib/auth.ts](../src/lib/auth.ts))

```ts
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { admin, bearer, organization, twoFactor } from "better-auth/plugins";
import { pool } from "@/lib/db";

export const auth = betterAuth({
  database: pool,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      console.log(`[mock-email] reset password for ${user.email}: ${url}`);
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      console.log(`[mock-email] verify email for ${user.email}: ${url}`);
    },
  },
  plugins: [organization(), admin(), twoFactor(), bearer(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
```

## Database migrations

Better Auth's built-in Kysely adapter can manage its own schema directly against the same `pg.Pool` used by the app:

```bash
cd src
npx @better-auth/cli@latest migrate
```

Re-run whenever a plugin is added or removed. The first migration covers `organization`, `admin`, `twoFactor`, `bearer`, and email verification tables.

## Implementation order

1. Install deps (`better-auth`, `pg`, `kysely`, `@types/pg`)
2. Create `src/lib/db.ts` (shared pool + Kysely)
3. Create `src/lib/auth.ts` with full plugin config
4. Create `src/app/api/auth/[...all]/route.ts`
5. Write `.env.local` + `.env.example`
6. Run `npx @better-auth/cli@latest migrate` against the Postgres container
7. Create `src/lib/auth-client.ts` with matching client plugins
8. Scaffold `(auth)` route group: layout + sign-in, sign-up, forgot-password, reset-password, verify-email, two-factor pages (minimal styling, Tailwind)
9. Add `src/middleware.ts` for protected route redirects
10. Smoke test sign-up -> mock verification log -> sign-in -> 2FA setup

## Post-implementation hand-off

- Start Postgres: `docker compose up -d postgresql` (from repo root)
- Generate secret + write `.env.local`
- Run the migration command above
- `pnpm dev` from `src/` and walk through the flows
- Mock email URLs will appear in the dev server console

## Security checklist (for production later)

- [ ] `BETTER_AUTH_SECRET` set (32+ chars)
- [ ] `advanced.useSecureCookies: true` in production
- [ ] `trustedOrigins` configured
- [ ] Rate limits enabled
- [ ] Real email provider wired up (Resend) in place of mock
- [ ] CSRF protection NOT disabled
- [ ] `account.accountLinking` reviewed when social providers are added
