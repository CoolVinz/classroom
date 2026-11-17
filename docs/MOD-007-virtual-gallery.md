# MOD-007 — Shared Classroom Virtual Gallery

**Status:** Existing gallery service is deployed; this movement, wand, and expanded-avatar revision is awaiting release and live multiplayer verification
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Give each classroom a shared third-person world where teachers and active students can walk among stable student display blocks. Eligible STL/OBJ/GLB/glTF work from active students and assignments appears automatically using saved thumbnails; full geometry loads near the visitor and is released when it is far away. Visitors can inspect a model and its student/assignment attribution. Students can like classmates' models once and undo their like. Teachers can hide or restore a display without changing the submission or assessment.

## Rules and access

- A teacher controls student access for a classroom they own; that teacher can also enter while stopped. Only active linked students can enter an enabled world; anonymous users cannot.
- The first world view assigns missing active students the next available block index. Existing blocks retain their index through roster-number changes, archival, and restoration.
- Only STL/OBJ/GLB/glTF model and submission files for active students and active assignments appear. Working files, worksheets, assessment data, and other uploads remain private.
- Student models hidden by a teacher are omitted from student manifests and content routes. Teachers can restore them from the hidden-work tray.
- Student likes are unique per model/student; self-likes are rejected. Likes do not affect assessment.
- Each classroom has one Colyseus room capped at 50 connections and one connection per account. Room positions are temporary; PostgreSQL retains settings, blocks, hidden displays, and likes.
- Colyseus admission uses a single-use 60-second ticket tied to the existing session. The service validates sessions and membership and rechecks access periodically. Movement is server-bounded and rate-limited.
- WASD/arrows and touch controls are camera-relative: W moves away from the camera and S toward it. The front of the face turns toward accepted travel direction, including diagonals; the server derives facing from accepted movement. Local movement predicts and reconciles server acknowledgements. Space or **กระโดด** starts a fixed-height jump.
- Saved thumbnails show every model in the loaded page. Full model geometry is fetched and parsed one at a time within 50 units, evicted beyond 62 units, and capped at one million resident triangles; individual previews retain the 500,000-triangle and 10-second limits. Rendering uses pixel ratio 1 without antialiasing and pauses while the page is hidden.
- On the student world page, the existing attendance panel continues to apply its visibility/focus rules. World movement and likes do not affect attendance.
- Teachers and students can save one account-level character appearance shared across classrooms: skin, hair, shirt, trouser, hat, glasses, and shoe colors; seven hairstyles; four hat styles; three glasses styles; and three shoe styles. Characters have visible eyes and a nose on the forward side; accessories use the same Three.js character helper in the editor and world. The Colyseus player state broadcasts appearance without changing identity, role, or position. Migration 017 adds defaults for existing accounts and validates all choices.
- Teachers may equip a wand and fire one server-simulated projectile every two seconds. Bolts travel at 20 units/second, stop at 30 units, and use server-derived teacher position, aim validation, movement, and student hit volumes. Duplicate recent shot IDs are ignored. A hit knocks down one unprotected student for ten seconds; they respawn at the entrance with three seconds of visible protection. Knockdown, countdown, protection, and a movement epoch survive reconnects while the room remains alive. Students can still move after respawning; protection only blocks further hits. Combat state is temporary and does not affect attendance, work, likes, or marks.
- OBJ files may include one UTF-8 MTL companion with solid `Kd` colors. Material maps are ignored and never fetched; students can see material colors in previews, saved thumbnails, and the world. Texture files and Blender shader materials are unsupported.
- Movement uses local prediction with server input acknowledgements. Small server corrections decay visually over several frames, with the camera following the same corrected display position; corrections above two units snap immediately. Local walking animation follows input rather than correction distance. The gallery caps pixel ratio at one, avoids antialiasing, and pauses animation and model loading in hidden tabs. These changes reduce avoidable work; measured FPS on school devices is still unknown.
- Appearance writes use JSON objects in PostgreSQL, preserving selections on a failed save. Movement pauses in the editor and when the page loses focus. Display lists synchronize when their data changes rather than on each animation frame; removed characters release geometry and materials.

## Dependencies and Code Map

**dependencies:** MOD-001, MOD-002, MOD-003, MOD-004, DAT-001
**used_by:** teacher classroom workspace and student portal

```text
Teacher UI and Three.js world: web/src/App.tsx, web/src/GalleryWorld.tsx, web/src/gallery-avatar.ts, web/src/gallery-motion.ts
Student entry: web/src/StudentPortal.tsx
Authenticated world APIs and model/material reads: src/routes/gallery.ts
Migrations: src/db/migrations/014_virtual_gallery.sql, src/db/migrations/015_gallery_avatars.sql, src/db/migrations/016_obj_material_files.sql, src/db/migrations/017_gallery_character_options.sql
Colyseus service, bounded movement, and temporary combat: gallery-server/src/server.mjs, gallery-server/src/movement.mjs, gallery-server/src/combat.mjs
Service deployment: gallery-server/Dockerfile; `/__healthcheck` route: gallery-server/src/server.mjs
Existing model parser and preview: web/src/model-view.ts, web/src/model-preview.worker.ts, web/src/parse-obj-model.ts, web/src/obj-materials.ts, web/src/ModelPreview.tsx
Tests: web/src/gallery-api.test.ts, web/src/gallery-motion.test.ts, web/src/gallery-avatar.test.ts, web/src/parse-obj-model.test.ts, src/student-workflow.test.ts, gallery-server/src/movement-check.mjs, gallery-server/src/combat-check.mjs, gallery-server/src/health-check.mjs; API and live-room integration needs an isolated migrated database
```

## Warnings and open questions

- Coolify uses a separate single-instance service for `gallery-server`, pointed at `gallery-server/Dockerfile`, plus `GALLERY_WS_URL` on the app. Configure its health check at `/__healthcheck`. Production WSS, real student accounts, simultaneous users, and VPS load have not been verified.
- Realtime service rooms are in-memory on one instance. Adding replicas requires shared Colyseus presence/matchmaking and load-balancer configuration.
- FPS has not been measured on school devices, under 50 connected visitors, or in a gallery with hundreds of displays. A device may still stutter when it renders many blocks or avatars.
- OBJ/MTL model files without saved previews or beyond model limits fall back to a thumbnail or an explanatory preview error. MTL texture maps and external resources are ignored. Model and companion files stay in the app's persistent upload volume.
- Network latency, school WebSocket filtering, and browser graphics performance may vary by device.
- The wand is a temporary classroom game feature. Rate limits and hit detection are server-authoritative, but live multiplayer timing, school-device rendering cost, and the student hit/respawn flow have not been browser-verified.

## Start/stop and glTF

Teachers start/stop student access with the existing enabled setting. The owning teacher may inspect a stopped world. Students cannot enter, fetch gallery content, or like displays while stopped. Active rooms check status every two seconds and disconnect students with code 4403; restart does not automatically reconnect them.

GLB and embedded glTF 2.0 use the shared worker and Three.js loader. External resource URIs, Draco/Meshopt/KTX2 compression, and unsupported required extensions are rejected. Default scenes render statically with transforms, materials, and embedded PNG/JPEG textures. Decoded images are limited to 16 million pixels per model; the world caps resident texture allocations including mipmaps at 128 MiB and releases textures with distant geometry. Existing triangle/time limits remain.

Additional code: src/gltf.ts, web/src/parse-gltf-model.ts. Run bun test ./src/gallery-world.integration.ts separately with CLASSROOM_TEST_DATABASE_URL pointing to an isolated migrated database; it starts a local Colyseus server and verifies stop/restart, stale tickets, and teacher access.
