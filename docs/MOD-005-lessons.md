# MOD-005 — Shareable Lesson Library

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Teachers create reusable lesson pages with ordered text, image, and YouTube blocks, or choose a full-page HTML/CSS/JavaScript editor when creating a page. Each teacher owns their lesson library. Published pages use a stable public link; students do not need an account to read them. When a student is already signed in, the reader includes the existing scheduled attendance tracker.

## Workflows and rules

- Teachers create and edit a private draft, preview it, and publish the saved content. Publishing saves the current editor state and switches the public snapshot in one database transaction.
- Draft changes do not replace the current public snapshot. Teachers can unpublish a page, which makes its reader and images unavailable; publishing it again reuses its link.
- The editor mode cannot change after creation. Custom lessons have HTML, CSS, and JavaScript source tabs, an explicit run/restart/stop preview, and a 1 MiB combined UTF-8 source limit. Full HTML documents and optional separate CSS/JavaScript are supported.
- Custom-code lessons offer None (default) or Bootstrap 5.3.9 CSS + JavaScript. The optional `framework` code-block field is saved with draft/published JSON snapshots; older snapshots without it use None. Preview and public readers inject the same pinned jsDelivr assets with verified SRI, before lesson code, under the existing CSP. Teachers should not import Bootstrap again when selected; their separate CSS is applied afterward. No migration or installed dependency is required. CDN access is required; Tailwind/daisyUI are deferred.
- Published title and content snapshots stay together. Editing a custom lesson does not change its public title or code before publish.
- Uploaded pictures can be inserted into code with `lesson-image://<uuid>` markers. The server derives and validates referenced images; both saved draft and public snapshots retain their image files.
- Custom code runs only in a sandboxed iframe with an opaque origin. A fixed CSP permits inline scripts/styles and selected CDN, font, image, and YouTube hosts, while blocking app API connections, forms, popups, and top-level navigation. Scripts can still navigate their own frame. Uploaded images are resolved to data URLs before the source enters the frame. The server never executes or serves source as same-origin HTML.
- Content is structured data. Text is rendered as text; only validated YouTube video IDs are used to construct privacy-enhanced embed URLs. Video players load after the reader clicks.
- Uploaded lesson pictures are decoded with `sharp`, bounded to 40 megapixels, resized within 1920 × 1920, stripped of metadata, and stored as WebP at quality 80.
- Images use the shared `/app/uploads` volume, configured per-file limit, and 5 GiB shared quota. Only images referenced in a saved draft or current published version are retained indefinitely; unreferenced images are eligible for cleanup after 24 hours.
- Every draft save and publish checks an expected revision. Conflicting edits return 409 and leave the editor's content intact.
- Public routes expose only published content. Public image routes require the image UUID to appear in the current published blocks or custom-code image manifest. Teacher image routes require lesson ownership.
- These pages are public to anyone with the link. They have no listing directory and student reading progress is not recorded. Existing attendance is tracked only for authenticated students using the shared attendance component.
- Teachers may attach quiz buttons to draft and published snapshots. Their label and quiz ID publish atomically with the lesson, and buttons render in the parent reader outside a custom-code iframe. Opening a button requires student Google sign-in and an eligible classroom round; see MOD-006.
- Published source is public and visible to readers; never include secrets.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-003, MOD-006, DAT-001, TEC-001, OPS-001

**used_by:** none

**Code Map:**

```text
Teacher UI and source editor: web/src/LessonLibrary.tsx, web/src/CodeLesson.tsx
Public reader and content blocks: web/src/PublicLessonPage.tsx, web/src/LessonContent.tsx
Sandbox document and image markers: web/src/code-lesson.ts
Attendance on public lesson pages: web/src/StudentAttendance.tsx
Teacher and public APIs, including draft/published quiz links: src/routes/lesson-pages.ts
Storage quota, startup recovery, and image cleanup: src/file-storage.ts
Migrations: src/db/migrations/010_lesson_pages.sql, src/db/migrations/011_lesson_code.sql, src/db/migrations/012_quiz_builder.sql
Frame policy: src/content-security-policy.ts, src/server.ts
Routing and deployment: src/server.ts, web/src/App.tsx
Tests: src/student-workflow.test.ts (isolated PostgreSQL integration), web/src/code-lesson.test.ts
YouTube URL validation: web/src/youtube-url.ts, web/src/youtube-url.test.ts
```

## Technical debt and warnings

- Public links can be shared beyond the intended class. Unpublishing prevents future page and image requests but cannot recall content already copied or downloaded.
- Many or large code lesson images can use substantial browser memory because the preview embeds them in its isolated document; keep uploaded preview images small.
- Lesson JavaScript and approved third-party resources can consume browser resources. Publish only code you trust, and never include secrets.
- Lessons depend on YouTube playback and network access. Embedded videos may be unavailable if blocked by the video owner, Google Workspace, or school network.
- Lesson quiz buttons point to existing quiz rounds but do not embed question content; see MOD-006.
- Lesson completion records and video uploads are not implemented.

## Open questions

- Should lessons later be targetable to individual classrooms or stay reusable and link-based?
