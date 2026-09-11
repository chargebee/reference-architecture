# Shared signed-in header

Four pages had four different headers. `AppHeader` is now the only one, so the
logo, the nav, and Sign out sit in the same place everywhere behind a session.

## One component, no client hook

`app/_components/app-header.tsx` resolves the admin permission itself, so no page
threads `isAdmin` down. The current page is marked by an `active` prop rather
than `usePathname`, which keeps the nav a server component: each page already
knows its own route, so there is nothing to discover at runtime.

The logo links to `/`, which is what the assorted "← Pointer" and "Back to
Pointer" links were for. All of them are gone.

## Where it mounts

| Route | Mounted in | Why |
| --- | --- | --- |
| `/` | `page.tsx` | Signed-out visitors get `MarketingHome` and its own header |
| `/usage` | `layout.tsx` | Survives a `?range=` switch — `loading.tsx` only replaces the body |
| `/choose-plan` | `page.tsx` | Single page, no segment layout |
| `/admin`, `/admin/flow` | `layout.tsx` | One mount covers the segment |

`/admin` pays for a second `isAdminRequest` call, since its layout already ran
one for the gate. A permission probe on an operator-only page is not worth an
extra prop on every other caller.

## Height chain on /admin/flow

The flow canvas sized itself with `h-[calc(100vh-4rem)]`, hard-coding the height
of the header above it. A second header would have broken it, so the viewport
math is replaced by flex:

```
body                 min-h-full flex flex-col
└ admin layout       flex-1            ← no min-h-0: /admin content may exceed the viewport
  └ flow page        flex-1 min-h-0    ← shrinks below content so the canvas is bounded
    └ FlowCanvas     flex-1 min-h-0
      └ event log    flex-1 overflow-y-auto
```

`min-h-0` stops only where a page needs to grow past the viewport. Adding it to
the admin layout would leave tall `/admin` content overflowing its background.

## Changes

- `app/_components/app-header.tsx` — new
- `app/page.tsx` — `AppHeader`; `SignedInHome` no longer takes `isAdmin`
- `app/usage/layout.tsx`, `app/usage/page.tsx`, `app/usage/loading.tsx` — header
  moved to the layout, body widened to `max-w-6xl` to match it
- `app/choose-plan/page.tsx` — replaces its header, drops "Signed in as …"
- `app/choose-plan/_components/plan-picker.tsx` — drops "Back to Pointer"
- `app/admin/layout.tsx` — shell and header for the segment
- `app/admin/page.tsx` — drops its own back link and Sign out
- `app/admin/flow/page.tsx`, `.../FlowCanvas.tsx` — flex height instead of `100vh`
