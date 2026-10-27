# Classroom

A Thai-language classroom manager for teachers. It runs on Bun + ElysiaJS, serves a React web app, and stores data in PostgreSQL 18.

## Included

- Teacher sign-in; an owner can create, disable, and reset teacher accounts. Students sign in with school Google accounts and can join more than one classroom with the same account.
- Teacher-owned classrooms and student rosters. Students can be archived and restored without deleting attendance history.
- Daily attendance with present, absent, late, excused, and unmarked states.
- Classroom summaries by student and date range.
- XLSX/CSV roster import by student ID with optional email mapping; missing email addresses are generated for numeric IDs (including leading zeroes), and existing/archived IDs are skipped without changing their details.
- Classroom assignments, teacher worksheets, and private student submissions in PDF, image, Word, STL, or OBJ formats. Students can preview their own STL/OBJ files; teachers see submission status and can preview or download class work.
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

For student sign-in, [create a Google OAuth Web application client](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) and set `GOOGLE_CLIENT_ID` and `GOOGLE_WORKSPACE_DOMAIN=banjan.ac.th`. Add the visible app origin as an authorized JavaScript origin and the exact `APP_URL/api/auth/student/google` URL as an authorized redirect URI. For Vite development, use `http://localhost:5173` as the origin and callback base. Google sign-in requires a verified Workspace `hd` claim and an active matching classroom roster email; a school account alone does not grant access. The server follows [Google's ID-token verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

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
- `GOOGLE_CLIENT_ID`: public Google Web application client ID; required to enable student sign-in.
- `GOOGLE_WORKSPACE_DOMAIN`: Workspace domain allowed for student sign-in; defaults to `banjan.ac.th`.
- `OWNER_USERNAME`, `OWNER_DISPLAY_NAME`, and `OWNER_PASSWORD`: optional bootstrap values for the first deployment only. The app creates the initial owner only if no owner exists. Remove these values from Coolify after the first successful startup.

Mount a persistent Coolify volume at `/app/uploads` and ensure it is writable by the `bun` user (UID 1000). Keep off-server backups of both PostgreSQL and that volume. A volume survives normal container replacement but is not a backup. Do not add a database URL to the image or commit a `.env` file. Use a dedicated database login instead of the PostgreSQL administrator account. Configure Coolify's health check to use `/health/ready`.

Students choose Google sign-in and are linked automatically to active roster entries with the same school email. Numeric student IDs without an email receive an address such as `24514@banjan.ac.th`; teachers can correct a roster email before the student signs in. The Google redirect callback must exactly match the URI registered in Google Cloud. For Workspace for Education accounts, the school administrator may need to approve the app; Google restricts unconfigured third-party apps for students under 18 ([school administrator guidance](https://support.google.com/edu/classroom/answer/15163043)). The migration invalidates student sessions, so students sign in again after deployment; teacher sessions remain valid.

## Important operational details

- Migrations create tables only in the `classroom` schema. If that schema already contains untracked tables, initialization stops for inspection.
- Session cookies require HTTPS in production. `APP_URL` must use `https://` when `NODE_ENV=production`.
- Teacher passwords are hashed with Argon2id. Students authenticate with Google; the app verifies the token and Workspace domain before issuing a 14-day database-backed session. Session tokens are stored as hashes.
- Attendance is one record per student per class per date. Unmarked students stay unmarked; the summary counts only saved statuses.
- Teacher accounts can access only classrooms they own. The owner manages teacher accounts but does not gain access to a teacher's classroom data.
- Login throttling is in-memory per account identifier and per application process; it is suitable for the initial single-container deployment.
