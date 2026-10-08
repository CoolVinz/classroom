# REQ-001 — Shared Classroom Virtual World

**Status:** Planned; no gallery functionality is implemented.

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

## Preparation available in MOD-004

Model files link to a classroom, assignment, student, and uploading teacher separately. Each file has a stable UUID and remains stored with its original content. The current preview shares STL/OBJ parsing and geometry rendering primitives intended for later reuse.

## Open questions for the gallery phase

- What floor plan, block size, and navigation controls should the shared world use?
- Should teachers be able to hide or remove student models from the world?
- What student sign-in and account recovery workflow will fit the school's roster?
- What maximum model count and performance target should each world meet?
