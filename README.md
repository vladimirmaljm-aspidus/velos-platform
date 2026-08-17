# VELOS Trade Platform

Multi-tenant trade CRM/ERP for international commodity trading — offers,
invoices, proformas, portal, KYC, trade calculator, ERP/accounting, 3D trade
globe, document verification with GPS, and more.

## Stack

- **Framework**: Next.js 16 (App Router) + TypeScript 5
- **DB**: Supabase (Postgres + RLS) — Prisma schema kept in sync for dev builds
- **Auth**: Cookie-based sessions (NextAuth-style) + API keys (tenant-scoped)
- **UI**: Tailwind CSS 4 + shadcn/ui (New York) + Lucide icons
- **State**: Zustand (client) + TanStack Query (server)
- **Realtime**: WebSocket / socket.io (optional mini-service)
- **PDF**: react-pdf v4 with QR verification codes
- **Maps**: MapLibre GL + Dijkstra maritime router (no land crossing)

## Project layout

```
src/
  app/            Next.js App Router — pages + API routes
    api/          ~216 REST endpoints (multi-tenant, RLS-enforced)
    portal/       Partner portal (separate auth flow)
    verify/       Public document verification (GPS-gated)
  components/
    ui/           shadcn/ui component library
    views/        Per-module admin views (offers, invoices, trade calc, …)
    portal/       Partner portal UI
    verify/       Verification page UI
    layout/       App shell, sidebar, topbar
    common/       Shared building blocks
  lib/
    api/          API helpers (auth, audit, status-validator, doc-number, …)
    data/         Store abstraction (supabase / mock / prisma)
    supabase/     Client + types
    pdf/          PDF generation
    logistics/    Maritime router + ports + borders
    permissions/  RBAC catalog + enforcer
    auth/         Session + password + portal-session
    i18n/         Translations
    store/        Zustand stores
    hooks/        React hooks
    utils/        Helpers (geo-ip, exchange-rates, name-cipher, …)
  middleware.ts   Rate limiting + IP extraction
prisma/           schema.prisma + seed.ts
supabase/migrations/  SQL migrations applied to prod
public/           Static assets (logo, map tiles, robots)
tests/            Unit + integration tests (vitest)
```

## Local development

```bash
bun install
cp .env.example .env   # fill in your Supabase + admin credentials
bun run db:generate     # generate Prisma client
bun run db:push         # sync Prisma schema to local SQLite (dev only)
bun run dev             # http://localhost:3000
```

For first deploy, call `POST /api/setup` once with the admin credentials from
your `.env` to create the initial super-admin user.

## Production deploy (Render)

`render.yaml` defines the web service. Build command runs Prisma generate +
`next build`; start runs the standalone server. Set the env vars listed in
`.env.example` in the Render dashboard.

## Multi-tenancy

Every table carries a `tenant_id` column. RLS policies enforce
`tenant_id = current_setting('app.tenant_id')` on every query. The service
role bypasses RLS (used by background jobs + cron). API routes resolve the
tenant from the session/API-key and pass it to the store layer.

## License

Proprietary. All rights reserved.
