# TEC-001 — Current Application Architecture

## Overview

The app is a single-page React interface and JSON backend deployed together. Development uses a Vite server for the UI and a Bun/Elysia server for the API. Production serves Vite's static build through the Elysia application on one port.

```text
Browser
  └── React/Vite UI
        └── /api JSON requests
              └── Bun + Elysia routes
                    ├── session and ownership checks
                    └── parameterized Postgres.js queries
                          └── PostgreSQL 18+ / classroom schema
```

## Data flow and boundaries

- The browser sends same-origin requests with an HttpOnly session cookie; no access token is stored in browser storage.
- Elysia validates request shapes with TypeBox schemas. Shared helpers validate mutation origins and calendar dates.
- Route handlers resolve sessions and enforce owner-to-classroom scoping before reading or changing data.
- Postgres.js uses parameterized tagged-template queries. Attendance batches and password/session changes use transactions.
- A tracked initial migration runs at application startup or from `bun run db:migrate`. The application login must own the pre-created `classroom` schema. PostgreSQL data remains outside the app container.

## Code Map

```text
Web entry and screen workflows: web/src/main.tsx, web/src/App.tsx
Styles and HTML: web/src/styles.css, web/index.html
API server and production static files: src/server.ts
API routes: src/routes/auth.ts, src/routes/classrooms.ts, src/routes/teachers.ts
Auth and database: src/auth/session.ts, src/db/client.ts, src/db/bootstrap.ts
Schema: src/db/migrations/001_initial.sql
Security helpers: src/security.ts, src/http-error.ts
Build/deploy: vite.config.ts, Dockerfile
Tests: None found
```

## Runtime boundaries

- One Bun process serves the API and built UI; the initial Coolify deployment is a single app container.
- PostgreSQL is an external service. No local app data volume, cache, job queue, or file store exists.
- Liveness is exposed at `/health/live`; readiness checks PostgreSQL at `/health/ready`.
- There is no ORM, separate service layer, client router, external auth provider, or email service.

## Technical debt and warnings

- UI screens share `web/src/App.tsx`; backend route modules include direct SQL and business rules.
- No automated unit, database integration, or browser tests are present.
- Login throttling uses process-local memory; multiple replicas do not share limits.
- Deployment and migrations have not been exercised against the user's database or Coolify instance.

## Open questions

- What availability, backup/restore, and audit requirements apply to classroom records?
- Will deployments remain single-replica, or should session/login limiting be shared across replicas?
