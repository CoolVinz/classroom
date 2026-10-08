# TEC-001 — Current Application Architecture

## Overview

The app is a single-page React interface and JSON backend deployed together. Development uses a Vite server for the UI and a Bun/Elysia server for the API. Production serves Vite's static build through the Elysia application on one port.

```text
Browser
  └── React/Vite UI
        ├── /api JSON requests
        │     └── Bun + Elysia routes
        │           ├── session and ownership checks
        │           ├── parameterized Postgres.js queries
        │           │     └── PostgreSQL 18+ / classroom schema
        │           └── protected file routes
        │                 └── persistent Coolify volume
        └── browser-only model parsing worker
```

## Data flow and boundaries

- The browser sends same-origin requests with an HttpOnly session cookie; no access token is stored in browser storage.
- Elysia validates request shapes with TypeBox schemas. Shared helpers validate mutation origins and calendar dates.
- Route handlers resolve sessions and enforce owner-to-classroom scoping before reading or changing data.
- Postgres.js uses parameterized tagged-template queries. Attendance batches and password/session changes use transactions.
- Numbered tracked SQL migrations run at application startup or from `bun run db:migrate`. The application login must own the pre-created `classroom` schema. PostgreSQL data remains outside the app container.
- File contents live in the configured upload directory; file metadata and classroom ownership live in PostgreSQL. The API streams files only after verifying the session and classroom owner.
- The upload directory must be mounted persistently by Coolify and backed up separately from PostgreSQL.
- XLSX/CSV workbooks are parsed in the browser with SheetJS and are not uploaded or retained. The server revalidates mapped rows before inserting students in a transaction.
- Three.js and its loaders are loaded only when a teacher opens a model preview. A dedicated worker parses STL/OBJ and transfers bounded geometry to the renderer.

## Code Map

```text
Web entry and screen workflows: web/src/main.tsx, web/src/App.tsx
Styles and HTML: web/src/styles.css, web/index.html
API server and production static files: src/server.ts
API routes: src/routes/auth.ts, src/routes/classrooms.ts, src/routes/coursework.ts, src/routes/teachers.ts
Auth and database: src/auth/session.ts, src/db/client.ts, src/db/bootstrap.ts
Schema: src/db/migrations/001_initial.sql, src/db/migrations/002_assignments_files.sql
Files: src/file-storage.ts, web/src/ClassroomWork.tsx
Roster import: web/src/StudentRosterImport.tsx, web/src/roster-import.ts
Model preview: web/src/ModelPreview.tsx, web/src/model-preview.worker.ts
Security helpers: src/security.ts, src/http-error.ts
Build/deploy: vite.config.ts, Dockerfile
Tests: src/file-storage.test.ts, web/src/roster-import.test.ts
```

## Runtime boundaries

- One Bun process serves the API and built UI; the initial Coolify deployment is a single app container.
- PostgreSQL is external. A persistent Coolify mount is required for uploads; no cache or job queue exists.
- Liveness is exposed at `/health/live`; readiness checks PostgreSQL at `/health/ready`.
- There is no ORM, separate service layer, client router, external auth provider, or email service.

## Technical debt and warnings

- UI screens share `web/src/App.tsx`; backend route modules include direct SQL and business rules.
- Unit tests cover file validation and roster parsing. PostgreSQL ownership/quota integration and browser graphics tests are not configured.
- Login throttling uses process-local memory; multiple replicas do not share limits.
- Deployment and migrations have not been exercised against the user's database or Coolify instance.

## Open questions

- What availability, backup/restore, and audit requirements apply to classroom records?
- Will deployments remain single-replica, or should session/login limiting be shared across replicas?
