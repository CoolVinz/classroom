# TEC-001 — Current Application Architecture

## Overview

The app is a single-page React interface and JSON backend deployed together. Development uses a Vite server for the UI and a Bun/Elysia server for the API. Production serves Vite's static build through the Elysia application on one port.

```text
Browser
  └── React/Vite UI
        ├── /api JSON requests
        │     └── Bun + Elysia routes
        │           ├── role-specific teacher/student sessions and ownership checks
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
- Teacher and student APIs use separate session guards. Student access is derived from active roster links; student file routes return only class worksheets and files attributed to that student.
- Postgres.js uses parameterized tagged-template queries. Attendance batches and password/session changes use transactions.
- Numbered tracked SQL migrations run at application startup or from `bun run db:migrate`. The application login must own the pre-created `classroom` schema. PostgreSQL data remains outside the app container.
- File contents live in the configured upload directory; file metadata and classroom ownership live in PostgreSQL. File routes authorize either the owning teacher or a student with an active membership viewing a worksheet or their own file.
- The upload directory must be mounted persistently by Coolify and backed up separately from PostgreSQL.
- Student invitation and password recovery links are sent through a configurable SMTP transport. Tokens are random, one-time, expiring, and stored only as SHA-256 hashes.
- XLSX/CSV workbooks are parsed in the browser with SheetJS and are not uploaded or retained. The server revalidates mapped rows before inserting students in a transaction.
- Three.js and its loaders are loaded only when a teacher opens a model preview. A dedicated worker parses STL/OBJ and transfers bounded geometry to the renderer.

## Code Map

```text
Web entry and screen workflows: web/src/main.tsx, web/src/App.tsx
Styles and HTML: web/src/styles.css, web/index.html
API server and production static files: src/server.ts
API routes: src/routes/auth.ts, src/routes/student-auth.ts, src/routes/classrooms.ts, src/routes/coursework.ts, src/routes/student-coursework.ts, src/routes/teachers.ts
Auth and database: src/auth/session.ts, src/db/client.ts, src/db/bootstrap.ts
Schema: src/db/migrations/001_initial.sql, src/db/migrations/002_assignments_files.sql, src/db/migrations/003_student_submissions.sql
Files and mail: src/file-storage.ts, src/student-mail.ts, web/src/ClassroomWork.tsx, web/src/StudentPortal.tsx, web/src/StudentAccess.tsx
Roster import: web/src/StudentRosterImport.tsx, web/src/roster-import.ts
Model preview: web/src/ModelPreview.tsx, web/src/model-preview.worker.ts
Security helpers: src/security.ts, src/http-error.ts
Build/deploy: vite.config.ts, Dockerfile
Tests: src/file-storage.test.ts, src/student-workflow.test.ts, web/src/roster-import.test.ts
```

## Runtime boundaries

- One Bun process serves the API and built UI; the initial Coolify deployment is a single app container.
- PostgreSQL is external. A persistent Coolify mount is required for uploads; no cache or job queue exists.
- Liveness is exposed at `/health/live`; readiness checks PostgreSQL at `/health/ready`.
- There is no ORM, separate service layer, client router, or external identity provider. SMTP settings are supported but no provider is provisioned by the repository.

## Technical debt and warnings

- UI screens share `web/src/App.tsx`; backend route modules include direct SQL and business rules.
- Unit tests cover file validation and roster parsing. Student API integration tests run against an isolated PostgreSQL database when `CLASSROOM_TEST_DATABASE_URL` is set; browser graphics and live SMTP tests are not configured.
- Login throttling uses process-local memory keyed by account identifier; multiple replicas do not share limits.
- Deployment and migrations have not been exercised against the user's database or Coolify instance.

## Open questions

- What availability, backup/restore, and audit requirements apply to classroom records?
- Will deployments remain single-replica, or should session/login limiting be shared across replicas?
