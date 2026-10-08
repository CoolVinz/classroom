# OPS-001 — Deployment and Operations

**Status:** Docker deployment files are present; app deployment to the user's Coolify VPS has not been verified. A read-only preflight on 2026-10-08 confirmed PostgreSQL 18.6 and the existing `001_initial` migration baseline.

## Deployment method

- Coolify Git application using the repository-root `Dockerfile`.
- Multi-stage image builds locked Bun dependencies, builds the React/Vite frontend, checks TypeScript, then runs Bun 1.4.2 in a slim runtime image.
- One application container listens on `0.0.0.0:3000`; Coolify terminates HTTPS and routes the app domain to this port.
- Docker defines a database-aware health check. Coolify readiness path is `/health/ready`; liveness is `/health/live`.

## Services and data

- PostgreSQL 18 or newer is external to the application container.
- Admin setup creates a dedicated login and an app-owned `classroom` schema. The app login does not need privileges to create databases or schemas.
- The app uses PostgreSQL TLS by default. A private development database without TLS can explicitly set `DATABASE_SSL=disable`.
- App containers are replaceable. Classroom, roster, attendance, session, account, assignment, and file metadata is stored in PostgreSQL. Uploaded file contents require a persistent Coolify mount.
- Configure Coolify Persistent Storage with destination `/app/uploads` (or match `UPLOAD_DIR`) and make it writable by the Bun container user (`bun`, UID 1000). A missing or read-only mount prevents uploads or can put files in replaceable container storage.
- Persistent volumes survive container replacement but are not backups. Back up uploaded files off the VPS as well as PostgreSQL.
- The app applies numbered tracked migrations at startup. If `classroom` contains untracked objects, startup stops for inspection.

## Runtime environment

Provide variable names through Coolify; never bake values into the image or repository:

```text
NODE_ENV=production
PORT=3000
APP_URL
DATABASE_URL
DATABASE_SSL
DATABASE_POOL_SIZE
UPLOAD_DIR (defaults to /app/uploads)
UPLOAD_MAX_FILE_BYTES (defaults to 50 MiB)
UPLOAD_MAX_TOTAL_BYTES (defaults to 5 GiB)
OWNER_USERNAME (first-owner setup only)
OWNER_DISPLAY_NAME (first-owner setup only)
OWNER_PASSWORD (first-owner setup only)
```

`APP_URL` must be the public HTTPS origin. Initial owner variables create an owner only if none exists; remove them from Coolify after the first successful startup.

## Operational constraints

- The database endpoint must be reachable from the Coolify app network and accept the app login.
- Use a dedicated database login that owns only the app schema, and restrict database network access to the application server where possible.
- The preflight connection used the PostgreSQL `postgres` role, which owns the `classroom` schema. Do not use that superuser login as the deployed app credential; create a dedicated role that owns the app schema.
- Database backups are managed at the PostgreSQL service; the app container has no independent backup or migration rollback workflow.
- The file quota is enforced from registered PostgreSQL file rows across classrooms. Keep actual free disk space above the configured quota; interrupted staging files are cleaned at startup.
- Login throttling is process-local, so the documented initial target is a single application container.
- No Coolify volume declaration, compose file, CI pipeline, external monitoring, mail delivery, object storage, or cache is configured in the repository. Configure the volume in Coolify directly.

## Deploy and initialize

See [README deployment instructions](../README.md). After configuring the database role/schema and Coolify runtime values, the first app startup applies the migration. Supply the initial owner values for that first startup, then remove them. Verify `/health/ready` before inviting teachers.

## Open questions

- What backup schedule and recovery objective are required for attendance records?
- Should production retain one app replica, or should login limiting be moved to a shared service before scaling out?
