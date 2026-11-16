# MOD-007 — Shared Classroom Virtual Gallery

**Status:** Implemented; deployment is separately configured and not live-verified
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Give each classroom a shared third-person world where teachers and active students can walk among stable student display blocks. Eligible STL/OBJ work from active students and assignments appears automatically using saved thumbnails; nearby models load progressively. Visitors can inspect a model and its student/assignment attribution. Students can like classmates' models once and undo their like. Teachers can hide or restore a display without changing the submission or assessment.

## Rules and access

- A teacher enables the world for a classroom they own. Only active linked students and that classroom's teacher can enter; anonymous users cannot.
- The first world view assigns missing active students the next available block index. Existing blocks retain their index through roster-number changes, archival, and restoration.
- Only STL/OBJ model and submission files for active students and active assignments appear. Working files, worksheets, assessment data, and other uploads remain private.
- Student models hidden by a teacher are omitted from student manifests and content routes. Teachers can restore them from the hidden-work tray.
- Student likes are unique per model/student; self-likes are rejected. Likes do not affect assessment.
- Each classroom has one Colyseus room capped at 50 connections and one connection per account. Room positions are temporary; PostgreSQL retains settings, blocks, hidden displays, and likes.
- Colyseus admission uses a single-use 60-second ticket tied to the existing session. The service validates sessions and membership and rechecks access periodically. Movement is server-bounded and rate-limited.
- Saved thumbnails show all models in the loaded page. At most 12 nearby model files are parsed in sequence at a time, with a one-million-triangle resident budget; individual previews retain the existing 500,000-triangle and 10-second limits.
- On the student world page, the existing attendance panel continues to apply its visibility/focus rules. World movement and likes do not affect attendance.

## Dependencies and Code Map

**dependencies:** MOD-001, MOD-002, MOD-003, MOD-004, DAT-001
**used_by:** teacher classroom workspace and student portal

```text
Teacher UI and Three.js world: web/src/App.tsx, web/src/GalleryWorld.tsx
Student entry: web/src/StudentPortal.tsx
Authenticated world APIs and model file reads: src/routes/gallery.ts
Migration: src/db/migrations/014_virtual_gallery.sql
Colyseus service and bounded movement: gallery-server/src/server.mjs, gallery-server/src/movement.mjs
Service deployment: gallery-server/Dockerfile; `/__healthcheck` route: gallery-server/src/server.mjs
Existing model parser and preview: web/src/model-view.ts, web/src/model-preview.worker.ts, web/src/ModelPreview.tsx
Tests: web/src/gallery-api.test.ts, gallery-server/src/movement-check.mjs, gallery-server/src/health-check.mjs; API integration needs isolated PostgreSQL 18
```

## Warnings and open questions

- Coolify uses a separate single-instance service for `gallery-server`, pointed at `gallery-server/Dockerfile`, plus `GALLERY_WS_URL` on the app. Configure its health check at `/__healthcheck`. Production WSS, real student accounts, simultaneous users, and VPS load have not been verified.
- Realtime service rooms are in-memory on one instance. Adding replicas requires shared Colyseus presence/matchmaking and load-balancer configuration.
- STL/OBJ files without saved previews or beyond model limits fall back to a thumbnail or an explanatory preview error. Models stay in the app's persistent upload volume.
- Network latency, school WebSocket filtering, and browser graphics performance may vary by device.
