# OPS-001 — Deployment and Operations

**Status:** Classroom and its separate Colyseus gallery service are deployed on Coolify. The gallery HTTPS health endpoint was verified; real teacher/student room joining remains unverified.

## Deployment method

- Coolify Git application using the repository-root `Dockerfile`.
- Multi-stage image builds locked Bun dependencies, builds the React/Vite frontend, checks TypeScript, then runs Bun 1.4.2 in a slim runtime image.
- The application container listens on `0.0.0.0:3000`; Coolify terminates HTTPS and routes the app domain to this port.
- The virtual gallery has a second Coolify service built from `gallery-server/Dockerfile` with build context `gallery-server/`. It runs Node.js 22 and listens on port `2567`; publish it behind an HTTPS/WSS domain. Keep one service instance because room presence is in memory.
- Docker defines a database-aware health check. Coolify readiness path is `/health/ready`; liveness is `/health/live`.

## Services and data

- PostgreSQL 18 or newer is external to the application container.
- Admin setup creates a dedicated login and an app-owned `classroom` schema. The app login does not need privileges to create databases or schemas.
- The app uses PostgreSQL TLS by default. A private development database without TLS can explicitly set `DATABASE_SSL=disable`.
- App containers are replaceable. Classroom, roster, attendance, session, account, assignment, lesson, and file metadata is stored in PostgreSQL. Uploaded file contents require persistent storage. On 2026-11-02, production was configured with a Coolify Docker volume at `/app/uploads` and `UPLOAD_DIR=/app/uploads`; the live terminal confirmed it is mounted read/write and the Bun process runs as root.
- The 2026-11-02 production audit found 70 file metadata records but an empty upload directory and no previous Classroom container or upload volume. The PostgreSQL backup preserves metadata only; missing originals must be re-uploaded. Do not delete those records automatically.
- Persistent volumes survive container replacement but are not backups. Back up uploaded files off the VPS as well as PostgreSQL.
- Before attaching a volume to an existing deployment, copy recoverable files from the running container into it under their existing storage UUIDs. A new empty mount hides the old container directory; mounting does not recover missing data.
- The app applies numbered tracked migrations at startup. Migration `005_classroom_student_numbers.sql` adds classroom numbering; `006_scheduled_attendance.sql` adds timetable, dated lessons, attendance provenance, and visible-time records; `007_thumbnails_assessments.sql` adds saved-thumbnail metadata, assignment maximum scores, and private/published assessments; `008_thumbnail_media_type.sql` records PNG/WebP thumbnail formats while retaining existing PNG files; `009_working_blend_files.sql` adds Blender working files; `010_lesson_pages.sql` adds teacher-owned lesson drafts and optimized lesson-image metadata; `011_lesson_code.sql` adds editor mode and published-title snapshots; `012_quiz_builder.sql` adds quiz drafts, immutable classroom rounds, student attempts, quiz images, and optional lesson quiz-link snapshots; `013_recoverable_trash.sql` adds quiz and lesson trash timestamps. If `classroom` contains untracked objects, startup stops for inspection.
- Migration `014_virtual_gallery.sql` adds per-classroom world settings, stable student blocks, teacher-hidden displays, likes, and short-lived room tickets. It preserves existing attendance, assignments, submissions, and files.
- Migration `015_gallery_avatars.sql` adds default appearance settings to teacher and student accounts. The app API saves them; the Colyseus service includes them in player state and refreshes connected rooms from PostgreSQL.
- Migration `017_gallery_character_options.sql` adds default accessory selections and widens the validated appearance options. Deploy the Classroom app first so this migration applies before deploying the updated Colyseus schema.
- Migration `018_gallery_train.sql` adds per-classroom mini-train mode, departure interval, and optional starting-student settings. Deploy the Classroom app first to apply migration 018, then deploy `gallery-server` from the same commit so its schema and train simulator are available. No new environment variable, dependency, or volume is required.
- Migration `020_gallery_submission_access.sql` adds the per-classroom student entry mode, per-student assignment approvals, and the shared eligibility view. Deploy the Classroom app first so it applies migration 020, then deploy `gallery-server` from the same commit; the service now checks the view for tickets, joins, and active sessions. The default mode requires the student's own submission on the latest active assignment.
- Migration `021_gallery_model_entry.sql` adds student-uploaded 3D models to the shared view without changing stored submissions or approvals. An existing Colyseus deployment that checks the view uses the corrected rule as soon as the migration commits.
- The vehicle release needs migration `023_gallery_station_waits.sql`. Deploy the Classroom app first and confirm readiness, then deploy the matching `gallery-server` release. Check `/__healthcheck` for readiness and `/__gallery_protocol` for `vehicles-v1`. The Colyseus restart disconnects visitors and clears the vehicle bay and any ongoing respawn countdowns.
- The Christmas gallery event uses migrations `024_gallery_santa_points.sql` and `025_gallery_santa_settings.sql`, the teacher-only `/api/classrooms/:classroomId/gallery/santa` settings endpoint, and the student-only `/api/student/gallery-points` endpoint. Deploy Classroom first and confirm `/health/ready`, then manually redeploy the matching Colyseus service. Check `/__gallery_protocol` for `santa-v2`; its restart disconnects visitors and ends any active event, gifts, blasts, and countdowns. Awarded point claims and per-classroom bomb settings remain in PostgreSQL. No new environment variable or dependency is required.
- For the point shop and on-demand rides, deploy Classroom first to apply migration `026_gallery_shop.sql`, then redeploy the Gallery service and check `/__gallery_protocol` for `shop-v1`. The restart ends active rides. Wallet balances, unused licenses, and remaining spells persist.
- Gallery movement/save fixes require redeploying both the main app and `gallery-server`; they need no additional migration or environment variables. Deploy the app first, then Colyseus. The app accepts older position state during rollout; the updated service also accepts older clients. New clients use sequenced movement acknowledgements and server-approved jump events. A gallery restart disconnects visitors, who must re-enter their world.

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
GOOGLE_CLIENT_ID (required to enable student sign-in)
GOOGLE_WORKSPACE_DOMAIN (defaults to banjan.ac.th)
GALLERY_WS_URL (public HTTPS URL for the Colyseus service)
OWNER_USERNAME (first-owner setup only)
OWNER_DISPLAY_NAME (first-owner setup only)
OWNER_PASSWORD (first-owner setup only)
```

`APP_URL` must be the public HTTPS origin. Initial owner variables create an owner only if none exists; remove them from Coolify after the first successful startup.

Configure the separate Colyseus service with the same `DATABASE_URL` and `DATABASE_SSL` used by the app, plus `PORT=2567`. Set `GALLERY_WS_URL` on the app to the public HTTPS origin routed to this service. The browser SDK upgrades the connection to WSS. Keep database credentials in Coolify variables only.

## Operational constraints

- The database endpoint must be reachable from the Coolify app network and accept the app login.
- Use a dedicated database login that owns only the app schema, and restrict database network access to the application server where possible.
- The preflight connection used the PostgreSQL `postgres` role, which owns the `classroom` schema. Do not use that superuser login as the deployed app credential; create a dedicated role that owns the app schema.
- Database backups are managed at the PostgreSQL service; the app container has no independent backup or migration rollback workflow.
- The shared file quota includes assignment originals, OBJ MTL companion files, assignment thumbnails, Blender working files, optimized lesson images, and optimized quiz images. Keep actual free disk space above the configured quota; interrupted staging files are cleaned at startup. Working files are stored unchanged on the upload volume. Lesson and quiz pictures are converted to WebP and retained while drafts, published versions, or classroom quiz snapshots reference them; unreferenced images can be cleaned after 24 hours.
- Code lessons use browser-only sandboxed frames; no runtime or editor package is installed. The app's frame policy must keep generated lesson previews, Google sign-in, and YouTube privacy embeds available. Lesson source and published images remain public through the lesson link.
- Login throttling is process-local, so the documented initial target is a single application container.
- Google sign-in uses a Web application client. Add the public app origin as an authorized JavaScript origin and the exact `${APP_URL}/api/auth/student/google` callback as an authorized redirect URI. The callback uses the visible app host (Vite's `/api` proxy in local development); the client ID is public and this ID-token flow needs no client secret.
- Set `GOOGLE_WORKSPACE_DOMAIN=banjan.ac.th`. The endpoint rejects unverified email, missing or wrong `hd`, wrong audience/issuer/expiry, invalid CSRF, and accounts without active roster matches.
- Google Workspace for Education may require school administrator approval before students, particularly under-18 users, can use the app.
- No Coolify deployment manifest, CI pipeline, external monitoring, object storage, cache, or shared Colyseus presence service is configured. Configure the existing app volume and the separate WebSocket service in Coolify.

## Deploy and initialize

Back up PostgreSQL and the upload volume before release because the app applies migrations on startup. For gallery train changes, deploy the app first so migration 018 and its settings API are ready, then deploy `gallery-server`. Verify `/health/ready`, teacher/student admission, ordered student spaces, saved train settings, manual and automatic departures, seat limits, disembarking, archived-member revocation, and a synthetic model upload appearing in its student's block. Uploaded file contents need their own off-server backup. See [README deployment instructions](../README.md).

## Open questions

- What backup schedule and recovery objective are required for attendance records?
- Should production retain one app replica, or should login limiting be moved to a shared service before scaling out?

## World controls and glTF release

Deploy Classroom first to apply migration 018, then deploy the separate Colyseus application from the same commit. No new environment variable, dependency, or volume is required. Stopping student access keeps the classroom teacher connected and leaves other classrooms running; the gallery service checks world status every two seconds. Confirm teacher inspection while stopped, rejected student entry, and restart after deployment. GLB/glTF files remain in the existing upload volume and shared quota. Texture-heavy models may remain thumbnail-only under the 128 MiB world texture budget.
