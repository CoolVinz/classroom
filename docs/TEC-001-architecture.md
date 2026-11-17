# TEC-001 — Current Application Architecture

## Overview

The app is a single-page React interface and JSON backend deployed together. Development uses a Vite server for the UI and a Bun/Elysia server for the API. Production serves Vite's static build through the Elysia application on one port.

```text
Browser
  └── React/Vite UI
        ├── /api JSON requests
        │     └── Bun + Elysia routes
        │           ├── teacher passwords and Google-verified student sessions
        │           ├── role-specific ownership and active roster checks
        │           ├── parameterized Postgres.js queries
        │           │     └── PostgreSQL 18+ / classroom schema
        │           └── protected file routes
        │                 └── persistent Coolify volume
        ├── public /lessons/:id reader
        ├── authenticated /quizzes/:id student attempt page
        ├── browser-only model parsing worker
        └── Colyseus WebSocket client
              └── separate Node.js gallery server
                    ├── one filtered room per classroom (50 clients max)
                    └── PostgreSQL session/ticket/member checks
```

## Data flow and boundaries

- The browser sends same-origin requests with an HttpOnly session cookie; no access token is stored in browser storage.
- Student sign-in uses Google's redirect-mode Identity Services button. Google posts a credential and double-submit CSRF token to the API; `google-auth-library` verifies the signed ID token, then the app checks the Workspace domain and active roster email matches before issuing a session.
- Elysia validates request shapes with TypeBox schemas. Shared helpers validate mutation origins and calendar dates.
- Route handlers resolve sessions and enforce owner-to-classroom scoping before reading or changing data.
- Teacher and student APIs use separate session guards. Student access is derived from active roster links; student file routes return only class worksheets and files attributed to that student.
- Postgres.js uses parameterized tagged-template queries. Attendance batches and password/session changes use transactions.
- Numbered tracked SQL migrations run at application startup or from `bun run db:migrate`. The application login must own the pre-created `classroom` schema. PostgreSQL data remains outside the app container.
- File contents live in the configured upload directory; file metadata and classroom ownership live in PostgreSQL. File routes authorize either the owning teacher or a student with an active membership viewing a worksheet or their own file.
- Public lesson URLs load a React reading page and published structured content from a separate public API. Teacher lesson routes require ownership; public image access requires the asset UUID in the current published snapshot. Lesson pictures use the same persistent volume and quota as assignment uploads.
- Teacher quiz APIs create revision-checked drafts and fixed classroom snapshots. Student quiz APIs require an active roster membership and serialize attempt changes, expiry, submissions, and teacher closure with a per-round database lock. Student payloads omit answer keys until solutions are released. Quiz images share the upload volume, quota, and staged cleanup with lesson images.
- Lesson quiz links are included in lesson draft/published JSON columns and rendered by the parent reader, outside custom lesson iframes. Google sign-in carries only a validated same-origin quiz route back to the attempt page.
- Custom lesson source remains JSON text in PostgreSQL. The browser resolves uploaded images to data URLs, appends optional inline CSS/JavaScript, and renders it in an opaque sandboxed iframe under a fixed CSP. The application shell restricts iframe sources to generated previews, Google sign-in, and privacy-enhanced YouTube.
- When a reader has a valid student session, it reuses the scheduled attendance panel and server lease; anonymous readers do not create attendance records.
- The upload directory must be mounted persistently by Coolify and backed up separately from PostgreSQL.
- Student accounts use Google's stable subject and retain their existing UUID when a verified matching email safely links a legacy account. The migration adds the subject field, backfills numeric student IDs, and invalidates old student sessions and email tokens; it preserves teacher sessions, attendance, assignments, and files.
- XLSX/CSV workbooks are parsed in the browser with SheetJS and are not uploaded or retained. The server revalidates mapped rows before inserting students in a transaction.
- Three.js and its loaders are loaded only when a teacher opens a model preview. A dedicated worker parses STL/OBJ and transfers bounded geometry to the renderer.
- The gallery viewer loads Three.js only when opened. It fetches a paged, authorized manifest and model thumbnails from Elysia, then uses the Colyseus SDK for temporary avatar state. The separate Node.js service consumes one-use tickets and revalidates PostgreSQL sessions/membership; it cannot use the app's HttpOnly cookie directly.
- Gallery settings, stable blocks, hidden displays, likes, and short-lived ticket hashes use migration 014. Account appearances use migrations 015 and 017; OBJ material companions use 016. Temporary movement, projectile, knockdown, and respawn state stays in the live Colyseus room and is not persisted. Existing file UUIDs and thumbnail metadata are reused; gallery-specific content endpoints protect peer model reads while leaving private coursework routes unchanged.

## Code Map

```text
Web entry and screen workflows: web/src/main.tsx, web/src/App.tsx
Styles and HTML: web/src/styles.css, web/index.html
API server and production static files: src/server.ts
API routes: src/routes/auth.ts, src/routes/student-auth.ts, src/routes/classrooms.ts, src/routes/coursework.ts, src/routes/student-coursework.ts, src/routes/quizzes.ts, src/routes/gallery.ts, src/routes/teachers.ts
Lesson routes and published quiz-link snapshots: src/routes/lesson-pages.ts
Auth and database: src/auth/session.ts, src/db/client.ts, src/db/bootstrap.ts
Schema: src/db/migrations/001_initial.sql, src/db/migrations/002_assignments_files.sql, src/db/migrations/003_student_submissions.sql, src/db/migrations/004_google_student_auth.sql, src/db/migrations/010_lesson_pages.sql, src/db/migrations/011_lesson_code.sql, src/db/migrations/012_quiz_builder.sql, src/db/migrations/014_virtual_gallery.sql
Files and quiz images: src/file-storage.ts, web/src/ClassroomWork.tsx, web/src/StudentPortal.tsx, web/src/LessonLibrary.tsx
Quiz interfaces and scoring: web/src/QuizLibrary.tsx, web/src/StudentQuizPage.tsx, src/quiz-core.ts
Public and code lesson reader: web/src/PublicLessonPage.tsx, web/src/LessonContent.tsx, web/src/CodeLesson.tsx, web/src/code-lesson.ts
Frame policy: src/content-security-policy.ts
Google identity: src/routes/student-auth.ts, google-auth-library
Roster import: web/src/StudentRosterImport.tsx, web/src/roster-import.ts
Model preview and gallery: web/src/ModelPreview.tsx, web/src/model-preview.worker.ts, web/src/GalleryWorld.tsx, gallery-server/src/server.mjs
Security helpers: src/security.ts, src/http-error.ts
Build/deploy: vite.config.ts, Dockerfile
Tests: src/file-storage.test.ts, src/student-workflow.test.ts, web/src/roster-import.test.ts, gallery-server/src/movement-check.mjs
```

## Runtime boundaries

- One Bun process serves the API and built UI. The Colyseus Node.js service is a separate Coolify container sharing PostgreSQL; one instance is required because active room state is in memory.
- PostgreSQL is external. A persistent Coolify mount is required for uploads; no cache or job queue exists.
- Liveness is exposed at `/health/live`; readiness checks PostgreSQL at `/health/ready`.
- There is no ORM, separate service layer, or client router. Google Workspace is the external student identity provider; no client ID or Workspace administrator approval is provisioned by the repository.
- The gallery service needs the app's database connection plus an externally reachable HTTPS/WSS address configured through `GALLERY_WS_URL`. Live proxy, capacity, and student-browser checks remain pending.

## Technical debt and warnings

- UI screens share `web/src/App.tsx`; backend route modules include direct SQL and business rules.
- Unit tests cover file validation and roster parsing. Student API integration tests run against an isolated PostgreSQL database when `CLASSROOM_TEST_DATABASE_URL` is set; Google token verification is mocked in tests, and no live school-account or browser graphics test is configured.
- Login throttling uses process-local memory keyed by account identifier; multiple replicas do not share limits.
- Deployment and migrations have not been exercised against the user's database or Coolify instance.

## Open questions

- What availability, backup/restore, and audit requirements apply to classroom records?
- Will deployments remain single-replica, or should session/login limiting be shared across replicas?
