# MOD-005 — Shareable Lesson Library

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Teachers create reusable lesson pages with ordered text, image, and YouTube blocks. Each teacher owns their lesson library. Published pages use a stable public link; students do not need an account to read them. When a student is already signed in, the reader includes the existing scheduled attendance tracker.

## Workflows and rules

- Teachers create and edit a private draft, preview it, and publish the saved content. Publishing saves the current editor state and switches the public snapshot in one database transaction.
- Draft changes do not replace the current public snapshot. Teachers can unpublish a page, which makes its reader and images unavailable; publishing it again reuses its link.
- Content is structured data. Text is rendered as text; only validated YouTube video IDs are used to construct privacy-enhanced embed URLs. Video players load after the reader clicks.
- Uploaded lesson pictures are decoded with `sharp`, bounded to 40 megapixels, resized within 1920 × 1920, stripped of metadata, and stored as WebP at quality 80.
- Images use the shared `/app/uploads` volume, configured per-file limit, and 5 GiB shared quota. Only images referenced in a saved draft or current published version are retained indefinitely; unreferenced images are eligible for cleanup after 24 hours.
- Every draft save and publish checks an expected revision. Conflicting edits return 409 and leave the editor's content intact.
- Public routes expose only published content. Public image routes require the image UUID to appear in the current published blocks. Teacher image routes require lesson ownership.
- These pages are public to anyone with the link. They have no listing directory and student reading progress is not recorded. Existing attendance is tracked only for authenticated students using the shared attendance component.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-003, DAT-001, TEC-001, OPS-001

**used_by:** none

**Code Map:**

```text
Teacher UI: web/src/LessonLibrary.tsx
Public reader and content blocks: web/src/PublicLessonPage.tsx, web/src/LessonContent.tsx
Attendance on public lesson pages: web/src/StudentAttendance.tsx
Teacher and public APIs: src/routes/lesson-pages.ts
Storage quota, startup recovery, and image cleanup: src/file-storage.ts
Migration: src/db/migrations/010_lesson_pages.sql
Routing and deployment: src/server.ts, web/src/App.tsx
Tests: src/student-workflow.test.ts (isolated PostgreSQL integration)
YouTube URL validation: web/src/youtube-url.ts, web/src/youtube-url.test.ts
```

## Technical debt and warnings

- Public links can be shared beyond the intended class. Unpublishing prevents future page and image requests but cannot recall content already copied or downloaded.
- Lessons depend on YouTube playback and network access. Embedded videos may be unavailable if blocked by the video owner, Google Workspace, or school network.
- No quizzes, lesson completion records, or video uploads are implemented.

## Open questions

- Should lessons later be targetable to individual classrooms or stay reusable and link-based?
