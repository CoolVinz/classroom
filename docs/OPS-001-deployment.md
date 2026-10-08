# OPS-001 — Deployment and Operations

**Status:** Docker deployment files are present; deployment to the user's Coolify VPS has not been verified.

## Deployment method

- Coolify Git application using the repository-root `Dockerfile`.
- Multi-stage image builds locked Bun dependencies, builds the React/Vite frontend, checks TypeScript, then runs Bun 1.4.2 in a slim runtime image.
- One application container listens on `0.0.0.0:3000`; Coolify terminates HTTPS and routes the app domain to this port.
- Docker defines a database-aware health check. Coolify readiness path is `/health/ready`; liveness is `/health/live`.

## Services and data

- PostgreSQL 18 or newer is external to the application container.
- Admin setup creates a dedicated login and an app-owned `classroom` schema. The app login does not need privileges to create databases or schemas.
- The app uses PostgreSQL TLS by default. A private development database without TLS can explicitly set `DATABASE_SSL=disable`.
- App containers are stateless. All classroom, roster, attendance, session, and account data is stored in PostgreSQL. No file uploads or local volume are required.
- The app applies its tracked migration at startup. If `classroom` contains untracked objects, startup stops for inspection.

## Runtime environment

Provide variable names through Coolify; never bake values into the image or repository:

```text
NODE_ENV=production
PORT=3000
APP_URL
DATABASE_URL
DATABASE_SSL
DATABASE_POOL_SIZE
OWNER_USERNAME (first-owner setup only)
OWNER_DISPLAY_NAME (first-owner setup only)
OWNER_PASSWORD (first-owner setup only)
```

`APP_URL` must be the public HTTPS origin. Initial owner variables create an owner only if none exists; remove them from Coolify after the first successful startup.

## Operational constraints

- The database endpoint must be reachable from the Coolify app network and accept the app login.
- Use a dedicated database login that owns only the app schema, and restrict database network access to the application server where possible.
- Database backups are managed at the PostgreSQL service; the app container has no independent backup or migration rollback workflow.
- Login throttling is process-local, so the documented initial target is a single application container.
- No Coolify project manifest, compose file, CI pipeline, external monitoring, mail delivery, object storage, or cache is configured in the repository.

## Deploy and initialize

See [README deployment instructions](../README.md). After configuring the database role/schema and Coolify runtime values, the first app startup applies the migration. Supply the initial owner values for that first startup, then remove them. Verify `/health/ready` before inviting teachers.

## Open questions

- What backup schedule and recovery objective are required for attendance records?
- Should production retain one app replica, or should login limiting be moved to a shared service before scaling out?
