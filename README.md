# Classroom

A Thai-language classroom manager for teachers. It runs on Bun + ElysiaJS, serves a React web app, and stores data in PostgreSQL 18.

## Included

- Teacher sign-in; an owner can create, disable, and reset teacher accounts.
- Teacher-owned classrooms and student rosters. Students can be archived and restored without deleting attendance history.
- Daily attendance with present, absent, late, excused, and unmarked states.
- Classroom summaries by student and date range.
- XLSX/CSV roster import by student ID; existing and archived IDs are skipped.
- Classroom assignments, worksheet uploads, and student-linked STL/OBJ models with browser previews.
- Thai interface, Bangkok date boundaries, and layouts for desktop and mobile.

## Local development

Install Bun 1.4.2 or newer and PostgreSQL 18. Create a dedicated app login and an app-owned schema in the target database. The PostgreSQL administrator can run this once while connected to the database named in the connection URL:

```sql
CREATE ROLE classroom_app LOGIN PASSWORD 'choose-a-unique-password-outside-the-repository';
GRANT CONNECT ON DATABASE postgres TO classroom_app;
CREATE SCHEMA classroom AUTHORIZATION classroom_app;
```

The app login then owns only the `classroom` schema and its tables; it does not need permission to create databases or other schemas. If a `classroom` schema already exists, inspect its contents and owner before proceeding.

```sh
bun install
cp .env.example .env
```

Set `DATABASE_URL` to your PostgreSQL connection URL and keep it only in the ignored local `.env` file or your deployment provider's runtime variables. The app requires PostgreSQL 18 or newer. TLS is required by default; for local development on a private network, set `DATABASE_SSL=disable` only when PostgreSQL does not offer TLS.

Start the API and web development server in separate terminals:

```sh
bun run dev
bun run dev:web
```

Open `http://localhost:5173`. The Vite server forwards `/api` requests to the Elysia server on port `3000`. On first startup, the app applies its tracked migration inside the app-owned `classroom` schema. It stops if that schema contains untracked objects.

Create the first owner account once. Enter the password without echo, then clear its environment variables after the command:

```sh
export OWNER_USERNAME=owner
export OWNER_DISPLAY_NAME="School owner"
read -r -s OWNER_PASSWORD
export OWNER_PASSWORD
bun run owner:create
unset OWNER_PASSWORD OWNER_USERNAME OWNER_DISPLAY_NAME
```

The initial password must be at least 12 characters. Subsequent teachers and password resets are managed in the owner screen.

## Production build

```sh
bun run build
bun run typecheck
bun run test
bun run start
```

`bun run db:migrate` applies all pending tracked migrations. Normal server startup also applies pending migrations. The service listens on port `3000`; `/health/live` checks the process, and `/health/ready` checks the database.

## Coolify

Connect this Git repository as a Dockerfile application and use the repository-root `Dockerfile`. Set the exposed port to `3000`, choose a domain, enable HTTPS, and provide these runtime variables in Coolify:

- `DATABASE_URL`: PostgreSQL 18 connection URL, entered as a secret.
- `APP_URL`: the app's public HTTPS origin, such as `https://classroom.example.com`.
- `DATABASE_SSL`: `require` (default) when the database endpoint supports TLS.
- `DATABASE_POOL_SIZE`: optional connection pool size; default `10`.
- `UPLOAD_DIR`: persistent upload directory; production default `/app/uploads` (the local `.env.example` uses `./uploads`).
- `UPLOAD_MAX_FILE_BYTES`: per-file limit; default 50 MiB.
- `UPLOAD_MAX_TOTAL_BYTES`: total file limit across the app; default 5 GiB.
- `OWNER_USERNAME`, `OWNER_DISPLAY_NAME`, and `OWNER_PASSWORD`: optional bootstrap values for the first deployment only. The app creates the initial owner only if no owner exists. Remove these values from Coolify after the first successful startup.

Mount a persistent Coolify volume at `/app/uploads` and ensure it is writable by the `bun` user (UID 1000). Keep off-server backups of both PostgreSQL and that volume. A volume survives normal container replacement but is not a backup. Do not add a database URL to the image or commit a `.env` file. Use a dedicated database login instead of the PostgreSQL administrator account. Configure Coolify's health check to use `/health/ready`.

## Important operational details

- Migrations create tables only in the `classroom` schema. If that schema already contains untracked tables, initialization stops for inspection.
- Session cookies require HTTPS in production. `APP_URL` must use `https://` when `NODE_ENV=production`.
- Passwords are hashed with Argon2id. Sessions are stored as hashes in PostgreSQL and expire after 14 days.
- Attendance is one record per student per class per date. Unmarked students stay unmarked; the summary counts only saved statuses.
- Teacher accounts can access only classrooms they own. The owner manages teacher accounts but does not gain access to a teacher's classroom data.
- Login throttling is in-memory per username and per application process; it is suitable for the initial single-container deployment.
