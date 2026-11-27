# MOD-006 — Quiz Builder

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Teachers maintain a reusable quiz library and assign immutable copies to classrooms. Students sign in with their existing school Google account, take one resumable attempt per round, and receive an automatically calculated total score. Completed quiz scores also appear in the teacher-only class gradebook (MOD-008), separate from assignment marks and attendance.

## Workflows and rules

- A teacher creates a draft, edits and reorders up to 100 single-answer multiple-choice or true/false questions, previews, and publishes. Each question has positive integer points, one correct choice, optional explanation and image; choices may also contain images. Drafts can be incomplete, while publication validates prompts, choices, and answer keys.
- Teachers can copy a versioned JSON prompt/template to an AI and paste its response for validation and preview. Import creates a separate private draft with fresh IDs; format `classroom-quiz` version 1 supports 1–100 text-only questions, multiple-choice answer numbers (1-based), and true/false booleans. Export uses current editor content and omits images; teachers review AI answers and add images in the builder.
- Teachers can also use a published quiz in a live 2D session. Live snapshots retain their referenced images and have their own questions, deadlines, and results. Trashing a source quiz cancels active live sessions and hides their history. Permanent deletion removes their records. See MOD-010.
- Teachers may assign a published snapshot to any owned active classroom, with an optional 1–240 minute countdown. The countdown starts with the student's first attempt. A round moves from awaiting opening to open to closed; closed rounds do not reopen.
- Library republishing or unpublishing does not change existing classroom snapshots. A teacher creates a new round to distribute a newer version.
- A student opening a quiz link must use Google sign-in. The app returns the student to the quiz route and selects a sole eligible round; multiple class/round options are selectable. Starting creates one attempt before question delivery. Reloads resume saved answers; revision checks reject stale tabs.
- The server owns timestamps and deadline calculations. At expiry, teacher close, or submit, saved answers are graded with no partial credit. Blank and incorrect answers score zero. A submitted total score is immediately visible.
- Student responses never include answer keys, correctness, awarded points per question, or explanations until the teacher closes the round and releases solutions. Teacher results include roster-ordered progress, scores, times, and individual answers. Quiz results do not enter assignment assessments.
- Teachers may add quiz buttons to block or custom-code lessons. Buttons are rendered by the parent lesson page, remain outside the custom-code iframe, and retain their published label/reference snapshot.
- Quiz pictures use the shared optimized WebP upload volume and shared quota. Students can request an image only after starting an authorized attempt and only when the round snapshot references it. Saved drafts, published quiz versions, and classroom snapshots retain their referenced images; unreferenced images are cleanup candidates after 24 hours.
- Active roster membership is checked for student access. Archiving a membership revokes access. Permanent student removal cascades only that classroom's attempts; shared accounts and other class records remain.
- Teachers can move quizzes to trash and restore them. Trash hides rounds, attempts, results, and quiz images from students and closes open rounds using the last saved answers. Restoration does not reopen those rounds. Permanent deletion requires the exact title, removes rounds, attempts, results, and images, and removes matching buttons from lesson snapshots while increasing affected lesson revisions. Permanent deletion is limited to trashed quizzes.
- Quiz trash does not expire. Images referenced by trashed snapshots remain retained and count toward shared storage. The trash view reports affected round and attempt counts before permanent deletion.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-002, MOD-005, DAT-001, TEC-001, OPS-001
**used_by:** MOD-005 lesson quiz buttons, MOD-008 class gradebook

**Code Map:**

```text
Teacher quiz library/editor and round results: web/src/QuizLibrary.tsx
Teacher class score grid: web/src/ClassGradebook.tsx
Student round selector, attempts, timer, autosave, and lesson entry: web/src/StudentQuizPage.tsx, web/src/StudentPortal.tsx
Teacher/student APIs, snapshots, locking, deadlines, scoring, and image access: src/routes/quizzes.ts
Content validation, scoring, privacy projection: src/quiz-core.ts, src/quiz-core.test.ts
AI quiz import/export format and validation: src/quiz-import.ts, src/quiz-import.test.ts, src/routes/ai-imports.ts
Lesson draft/published quiz links: src/routes/lesson-pages.ts, web/src/LessonLibrary.tsx, web/src/PublicLessonPage.tsx
Storage quotas, reconciliation, and image retention: src/file-storage.ts
Schema: src/db/migrations/012_quiz_builder.sql, src/db/migrations/013_recoverable_trash.sql
App routing and Google login return: src/server.ts, web/src/App.tsx, src/routes/student-auth.ts
PostgreSQL API coverage: src/student-workflow.test.ts (optional isolated database)
```

## Technical debt and warnings

- Expired attempts are finalized lazily on related reads/writes; there is no background worker. Scores use the last answer state accepted by the server.
- Autosave requires a connection; offline changes are not credited if they did not reach the server before expiry or teacher closure.
- Result changes are not synchronized live across open teacher/student screens; reloading fetches current state.
- Quiz images and other uploads are stored on the app host and require off-server backups.
- Permanent deletion has no undo. If image unlinking fails after records are deleted, startup reconciliation removes staged files.

## Open questions

- Should future quizzes support written answers, retakes, randomization, exports, or question banks?
- Should teachers have an explicit per-student attempt reset, or must they create a new round?
