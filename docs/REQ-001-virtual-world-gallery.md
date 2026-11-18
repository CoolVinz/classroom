# REQ-001 — Shared Classroom Virtual World

**Status:** Implemented as MOD-007; production deployment is not live-verified.

## Confirmed behavior

- Each classroom has one shared walk-through world, divided into a stable display block for each roster student.
- Every student will have an individual account linked to classroom roster membership.
- Students upload supported 3D models for classroom assignments. Successful uploads appear automatically in the uploader's block.
- Blocks can show multiple models. A later upload does not replace earlier model records or move them between students.
- The teacher and signed-in students in the classroom can visit. No anonymous access is allowed.
- Students can like another student's individual model, undo their own like, and view aggregate likes. A student can like a model only once and cannot like their own work.
- Likes are peer reactions, separate from teacher assessment. Ratings, voting, and comments are not in scope.
- The gallery reuses stable model-file UUIDs from MOD-004. It must not require students to upload the same file again.
- The world loads lightweight display models progressively so one class's full collection does not load at once.
- The first release uses a third-person walkable gallery with keyboard and touch controls, stable display blocks, teacher hide/restore, and a 50-visitor room cap.
- Active students' display spaces are positioned by classroom number, with unnumbered students last, while each database block identity stays stable. Spaces measure 12 × 10 units and are separated by walkways and a center aisle.
- A shared mini train makes automatic one- or two-minute circuits or teacher-started manual trips. It stops at the entrance and every three rows, carries up to 12 visitors, and permits boarding or leaving at open stations.

## Preparation available in MOD-004

Model files link to a classroom, assignment, student, and uploading teacher separately. Each file has a stable UUID and remains stored with its original content. The current preview shares STL/OBJ parsing and geometry rendering primitives intended for later reuse.

## Deployment and limits

- Gallery APIs and the React/Three.js viewer live in this repository. Colyseus runs as a separate Coolify service and checks one-time tickets against the same PostgreSQL database.
- Stable student blocks and teacher-hidden flags are persisted; visitor positions are temporary.
- The initial performance target is 50 concurrent visitors in one classroom room. Live capacity and device performance require load and browser checks after deployment.
- See MOD-007 for current routes, access boundaries, movement limits, and rendering caps.
