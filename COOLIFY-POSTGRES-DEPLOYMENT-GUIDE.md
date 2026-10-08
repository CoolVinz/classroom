# Coolify + PostgreSQL Deployment Guide

A reusable checklist for deploying a web application and PostgreSQL database with Coolify. Replace placeholders such as `<app_db>` and `<app_runtime>` with names for your project. Never put real passwords, connection strings, tokens, or private keys in this file or in Git.

## 1. Prepare the application

- Confirm the app starts locally and has a production build/start command.
- Document required environment variable **names**, ports, database version, migrations, and first-user setup. Keep secret values out of `.env.example`.
- Provide a lightweight readiness endpoint (for example, `/health/ready`) that returns success only when the app can serve requests and required dependencies are ready. Keep a separate liveness endpoint if useful.
- Make database migrations tracked, repeatable, and safe to run once. Decide whether they run as a deployment step or at app startup.

## 2. Create the Coolify resources

Create the application and PostgreSQL as separate Coolify resources on the same server and Docker network. Use PostgreSQL's internal port, normally `5432`.

For the application, use the database's **Internal URL** from Coolify as `DATABASE_URL`. It uses the database container's hostname and internal port. Do not use the VPS public IP and mapped database port for an app on that same network. Keep public database access disabled unless a remote client needs it; if enabled, restrict it with firewall rules. [Coolify database guidance](https://coolify.io/docs/databases/)

## 3. Create a dedicated database login

Do not run the application as PostgreSQL's `postgres` superuser. Create a separate database and a non-superuser login with access limited to the app. For example, connect as a database administrator and run:

```sql
CREATE ROLE <app_runtime> LOGIN PASSWORD '<unique-generated-secret>';
CREATE DATABASE <app_db>;
GRANT CONNECT ON DATABASE <app_db> TO <app_runtime>;
```

Connect to `<app_db>`, then create the application's schema:

```sql
CREATE SCHEMA <app_schema> AUTHORIZATION <app_runtime>;
```

Use the app login in `DATABASE_URL`. If migrations run using that login, it must be able to create and alter objects in the app schema; schema ownership is a simple way to grant that. For tighter separation, run migrations with a dedicated migration role and grant the runtime role only the table and sequence privileges the application needs. PostgreSQL owners have broad control over their objects, so limit ownership to the application schema. [PostgreSQL privileges](https://www.postgresql.org/docs/18/ddl-priv.html)

## 4. Configure secrets and environment variables

Add production values in the Coolify application's runtime environment. Typical names include:

```text
NODE_ENV=production
PORT=<container-port>
APP_URL=https://<app-domain>
DATABASE_URL=<Coolify-internal-database-url>
```

Mark secrets as runtime-only when they are not needed during the image build. Do not commit a real `.env`, bake secrets into the image, or pass secrets as ordinary Docker build arguments. Keep preview and production databases and credentials separate. Saving environment changes requires restarting or redeploying the app so the container receives them. [Coolify environment variables](https://coolify.io/docs/applications/configuration/environment-variables)

## 5. Enable and verify database TLS

Keep PostgreSQL TLS enabled. The `require` mode encrypts the connection but does not by itself verify the database server's identity. For stronger protection, configure the application client to trust the database CA and verify the certificate and hostname (`verify-full`, where supported). The certificate must be valid for the database hostname used by the app. [Coolify database SSL](https://coolify.io/docs/databases/ssl) · [PostgreSQL SSL modes](https://www.postgresql.org/docs/18/libpq-ssl.html)

Do not disable TLS just to get a deployment working. If you see errors such as `no suitable signature algorithm`, inspect the server certificate, TLS settings, PostgreSQL logs, and Coolify version. Treat the certificate issue reported in [Coolify issue #8601](https://github.com/coollabsio/coolify/issues/8601) as a specific compatibility case, not a reason to make unencrypted connections the default.

## 6. Initialize the database and first account

Before the app accepts traffic:

1. Confirm the database exists and is healthy.
2. Confirm the app login can connect to the selected database and owns or has the required rights on the app schema.
3. Run tracked migrations and check deployment logs for success.
4. Create the initial administrator/owner through a protected one-time process. Do not ship a default username/password. Remove temporary bootstrap secrets from Coolify after the account is created.

If the app reports that a schema is missing or owned by another role, fix that database prerequisite deliberately. Do not drop or recreate a non-empty schema until its data and migration state have been inspected.

## 7. Configure Coolify health checks and domain

Configure a health check for the app's readiness endpoint, using the container's internal port. For example: `GET http://localhost:<container-port>/health/ready`. A readiness check should include required dependencies such as PostgreSQL. Check that the final image contains `curl` or `wget` if Coolify runs an HTTP check from inside the container; alternatively define the check in the Dockerfile. [Coolify health checks](https://coolify.io/docs/applications/configuration/health-checks)

Point the app's DNS record (or a deliberately configured wildcard) to the VPS, add the same hostname to the Coolify app, and enable HTTPS. Website HTTPS (browser to proxy) and database TLS (app to PostgreSQL) are separate connections and must be verified separately.

## 8. Verify before calling deployment complete

Check in this order:

1. PostgreSQL is healthy and reachable from the app over its internal URL.
2. TLS succeeds with the configured certificate policy.
3. The app's database role, database, schema, and schema owner are correct.
4. Migrations complete successfully in deployment/runtime logs.
5. The readiness endpoint returns HTTP 200 and Coolify reports the app healthy.
6. The public domain opens over HTTPS and the main page renders.
7. The initial owner can sign in; temporary bootstrap secrets are removed.
8. A database backup exists and a restore has been tested.

A persistent database volume helps preserve files when a container is replaced, but it does not replace backups. Set a backup schedule and test restoring it before storing important production data. [Coolify database operations](https://coolify.io/docs/databases/)

## Troubleshooting signals

| Signal | Check first |
|---|---|
| “No available server” | App container status, startup logs, health-check result, exposed port, and domain routing. DNS can reach Coolify while the app itself is stopped or unhealthy. |
| Database connection timeout | Internal URL hostname/port, shared Docker network, database status, and firewall/public-access settings. |
| TLS or signature-algorithm error | PostgreSQL logs, server certificate/key algorithm, CA trust, hostname, TLS mode, and Coolify/PostgreSQL compatibility. |
| Missing schema or permission denied | Database name, schema existence, schema owner, app role, and migration logs. |
| Login page works but sign-in fails for every user | Confirm that an initial owner account was actually created and that its bootstrap secret was removed after setup. |

Coolify's proxy can return “No available server” when all app containers are unhealthy, so inspect the app and health-check state before changing DNS. [Coolify health-check behavior](https://coolify.io/docs/applications/configuration/health-checks)
