# Project Profile

## Project Identity

**Name:** Classroom (`classroom` repository)

**Description:** Teacher-facing classroom app for rosters, attendance, assignments, worksheets, and student 3D model submissions.

**Status:** Classroom features are implemented in the working tree. These changes still need to be deployed to Coolify; production uploads require the persistent volume described in `docs/OPS-001-deployment.md`.

**Documentation Status:** Retrofitted; see `PROJECT_INDEX.md` for selective retrieval.

---

# Technology Stack

## Frontend

Framework: React 19 with Vite 8
Language: TypeScript
UI library: React
CSS: Plain responsive CSS in `web/src/styles.css`
State management: Local React state and hooks
Forms: Native controlled HTML forms
Validation: Browser constraints and Elysia/TypeBox request validation

## Backend

Runtime: Bun (local checks used Bun 1.2.2; Docker runtime is pinned to Bun 1.4.2)
Framework: Elysia 1.4
API style: JSON HTTP routes under `/api`
Authentication: Argon2id password hashes and PostgreSQL-backed, hashed 14-day session tokens in HttpOnly cookies
Background jobs: None

## Database

Database: PostgreSQL 18 or newer; checked at startup
ORM / query layer: Postgres.js 3 with parameterized SQL tagged templates; no ORM
Migration system: Ordered tracked SQL files under `src/db/migrations/`; startup and `bun run db:migrate` apply pending migrations

## Infrastructure

Hosting: User's Coolify-enabled VPS (target; PostgreSQL 18.6 connection verified read-only, app deployment not verified)
Deployment: Repository-root multi-stage Dockerfile
Containers: One Bun application container; PostgreSQL is external and file data is stored on a persistent Coolify volume
Reverse proxy: Coolify domain/HTTPS proxy, configured outside this repository
File storage: Local `./uploads` by default in development; Coolify persistent volume at `/app/uploads` in production. PostgreSQL stores file metadata and ownership.
Cache: None
Queue: None
Email: None
Monitoring: `/health/live` and database-aware `/health/ready`; no external monitoring integration

---

# Package / Dependency Management

Runtime: Bun
Package manager: Bun
Lock file: `bun.lock`

Important resolved dependencies include Elysia 1.4.30, React 19.3.0, Vite 8.3.3, Three.js 0.186.1, SheetJS CE 0.20.3, `@vitejs/plugin-react` 6.1.2, TypeScript 5.9.3, and Postgres.js 3.4.9.

---

# Repository Structure

```text
src/server.ts                 Elysia application, health routes, static files
src/routes/                   Authentication, classroom, attendance, teacher, assignment/file APIs
src/auth/session.ts           Session cookies, lookup, and access checks
src/db/                       PostgreSQL client, startup migration, owner setup
src/db/migrations/            Ordered tracked PostgreSQL schema migrations
src/file-storage.ts           Upload validation, size limits, and persistent volume
web/src/ClassroomWork.tsx     Assignment and file workflows
web/src/roster-import.ts      XLSX/CSV parsing and roster preview
web/src/ModelPreview.tsx      Three.js viewer
web/src/model-preview.worker.ts STL/OBJ parser worker
src/security.ts               Origin, date, and input helpers
web/src/App.tsx               React app screens and workflows
web/src/styles.css            Responsive Thai interface styles
web/index.html                Vite frontend entry
Dockerfile                    Coolify-ready application image
README.md                     Local setup, database provisioning, and deployment
docs/MOD-*.md                 Functional-module maps and behavior
docs/REQ-001-virtual-world-gallery.md Confirmed future gallery requirements
docs/PROJ-001-overview.md     Product purpose and user workflows
docs/DAT-001-data-model.md    Entity relationships and ownership
docs/TEC-001-architecture.md Current application architecture
docs/OPS-001-deployment.md    Docker, Coolify, and environment setup
```

---

# Current Application Architecture

React/Vite serves the single-page teacher interface. During development Vite forwards `/api` to the Bun/Elysia server. In production Elysia serves the built frontend and JSON API from the same container. Route handlers use a shared session guard and parameterized Postgres.js queries against the `classroom` schema. PostgreSQL stores records; uploaded file contents need a persistent Coolify mount. See [TEC-001](docs/TEC-001-architecture.md).

---

# Important Entry Points

Application: `src/server.ts`, `web/src/main.tsx`
API / Backend: `src/routes/auth.ts`, `src/routes/classrooms.ts`, `src/routes/coursework.ts`, `src/routes/teachers.ts`
Database: `src/db/client.ts`, `src/db/bootstrap.ts`, `src/db/migrations/`
Files: `src/file-storage.ts`, `web/src/ClassroomWork.tsx`
Authentication: `src/auth/session.ts`
Shared Services: `src/security.ts`, `src/http-error.ts`
Tests: `bun test` (file validation and roster parsing; no PostgreSQL/browser integration suite)

---

# Development Commands

## Install

```sh
bun install
```

## Development

```sh
# Terminal 1: API and automatic migration
bun run dev

# Terminal 2: React/Vite development server
bun run dev:web
```

## Build and type check

```sh
bun run build
bun run typecheck
bun test
```

## Start

```sh
bun run start
```

## Database / Migration / Owner setup

```sh
bun run db:migrate
bun run owner:create
```

The initial owner can also be provisioned once with the `OWNER_USERNAME`, `OWNER_DISPLAY_NAME`, and `OWNER_PASSWORD` variables on first startup. Remove these variables after the first successful startup.

## Tests / Lint

`bun test` runs the focused file validation and roster parsing tests. Type checking is not a replacement for PostgreSQL integration or browser tests.

---

# Environment Variables

Names only; never store their secret values in documentation.

```text
NODE_ENV
PORT
APP_URL
DATABASE_URL
DATABASE_SSL
DATABASE_POOL_SIZE
UPLOAD_DIR
UPLOAD_MAX_FILE_BYTES
UPLOAD_MAX_TOTAL_BYTES
OWNER_USERNAME
OWNER_DISPLAY_NAME
OWNER_PASSWORD
```

`OWNER_*` values are for first-owner provisioning only and should be removed after the account is created.

---

# Technical Constraints

- Requires PostgreSQL 18 or newer and a dedicated login that owns the `classroom` schema.
- Migrations stop if untracked objects exist in that schema; inspect existing objects before first deployment.
- Production requires `APP_URL` with HTTPS. Database TLS is required unless explicitly disabled for a private development environment.
- Each teacher can access only classrooms they own. The owner manages teacher accounts but does not gain access to other teachers' classroom data.
- One daily attendance record is stored per student/date; valid statuses are present, absent, late, and excused. Unmarked students have no record.
- A model file belongs to one classroom, assignment, and student; worksheets belong to a classroom assignment. File contents require persistent volume storage and off-server backup.
- File uploads default to 50 MiB each and 5 GiB total. Model previews are limited to 500,000 triangles and 10 seconds of parsing.
- Roster import requires student IDs, skips existing and archived IDs, and never changes attendance.
- Login throttling and sessions are process/database based respectively; login throttling is in-memory per username per application process.

---

# Important Shared Infrastructure

- `src/db/client.ts` is the shared PostgreSQL pool.
- `src/auth/session.ts` provides shared authentication and owner checks for API routes.
- `src/security.ts` contains write-origin, date, and input helpers.
- `src/http-error.ts` supplies HTTP errors translated by the Elysia application handler.

---

# Known Technical Debt

- No PostgreSQL ownership/quota integration, upload endpoint integration, or browser graphics tests are present.
- Frontend screens and workflows currently live together in `web/src/App.tsx`.
- API route handlers combine validation, authorization, and database queries; a distinct service layer does not exist.
- Login throttling is per username in process memory; a single-process deployment is the documented starting point.
- The new migrations, Coolify volume permissions, uploads, and redeployment persistence have not been exercised on the production VPS.

---

# Source of Truth

```text
code
```

---

# Last Verified

Date: 2026-10-08
Commit: `7bd3d4a8a3c6c4f61a71ba7a9bbbf5e8c350891a`
