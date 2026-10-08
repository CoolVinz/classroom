# Project Profile

## Project Identity

**Name:** Classroom (`classroom` repository)

**Description:** Teacher-facing classroom, roster, daily attendance, and attendance-summary app.

**Status:** First implementation built; database and Coolify deployment still require environment setup and connection verification.

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
Migration system: Tracked `src/db/migrations/001_initial.sql`; startup and `bun run db:migrate` apply the migration

## Infrastructure

Hosting: User's Coolify-enabled VPS (target; live connection not verified)
Deployment: Repository-root multi-stage Dockerfile
Containers: One stateless Bun application container; PostgreSQL is external
Reverse proxy: Coolify domain/HTTPS proxy, configured outside this repository
File storage: None
Cache: None
Queue: None
Email: None
Monitoring: `/health/live` and database-aware `/health/ready`; no external monitoring integration

---

# Package / Dependency Management

Runtime: Bun
Package manager: Bun
Lock file: `bun.lock`

Important resolved dependencies include Elysia 1.4.30, React 19.3.0, Vite 8.3.3, `@vitejs/plugin-react` 6.1.2, TypeScript 5.9.3, and Postgres.js 3.4.9.

---

# Repository Structure

```text
src/server.ts                 Elysia application, health routes, static files
src/routes/                   Authentication, classroom, student, attendance, teacher APIs
src/auth/session.ts           Session cookies, lookup, and access checks
src/db/                       PostgreSQL client, startup migration, owner setup
src/db/migrations/            Tracked PostgreSQL schema migration
src/security.ts               Origin, date, and input helpers
web/src/App.tsx               React app screens and workflows
web/src/styles.css            Responsive Thai interface styles
web/index.html                Vite frontend entry
Dockerfile                    Coolify-ready application image
README.md                     Local setup, database provisioning, and deployment
docs/MOD-*.md                 Functional-module maps and behavior
docs/PROJ-001-overview.md     Product purpose and user workflows
docs/DAT-001-data-model.md    Entity relationships and ownership
docs/TEC-001-architecture.md Current application architecture
docs/OPS-001-deployment.md    Docker, Coolify, and environment setup
```

---

# Current Application Architecture

React/Vite serves the single-page teacher interface. During development Vite forwards `/api` to the Bun/Elysia server. In production Elysia serves the built frontend and JSON API from the same container. Route handlers use a shared session guard and parameterized Postgres.js queries against the `classroom` schema. PostgreSQL owns app records; the container is stateless. See [TEC-001](docs/TEC-001-architecture.md).

---

# Important Entry Points

Application: `src/server.ts`, `web/src/main.tsx`
API / Backend: `src/routes/auth.ts`, `src/routes/classrooms.ts`, `src/routes/teachers.ts`
Database: `src/db/client.ts`, `src/db/bootstrap.ts`, `src/db/migrations/001_initial.sql`
Authentication: `src/auth/session.ts`
Shared Services: `src/security.ts`, `src/http-error.ts`
Tests: No automated test suite is configured or present

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

No test or lint command is configured. `bun run typecheck` is a static type check, not a behavioral test.

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
- Login throttling and sessions are process/database based respectively; login throttling is in-memory per username per application process.

---

# Important Shared Infrastructure

- `src/db/client.ts` is the shared PostgreSQL pool.
- `src/auth/session.ts` provides shared authentication and owner checks for API routes.
- `src/security.ts` contains write-origin, date, and input helpers.
- `src/http-error.ts` supplies HTTP errors translated by the Elysia application handler.

---

# Known Technical Debt

- No automated behavior or database integration tests are present.
- Frontend screens and workflows currently live together in `web/src/App.tsx`.
- API route handlers combine validation, authorization, and database queries; a distinct service layer does not exist.
- Login throttling is per username in process memory; a single-process deployment is the documented starting point.
- Live PostgreSQL, container-image, and Coolify deployment checks remain pending environment setup.

---

# Source of Truth

```text
code
```

---

# Last Verified

Date: 2026-10-08
Commit: `7bd3d4a8a3c6c4f61a71ba7a9bbbf5e8c350891a`
