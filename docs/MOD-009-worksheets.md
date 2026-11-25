# MOD-009 — Worksheet Activities

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and workflow

Teachers create reusable worksheets under **ใบงานกิจกรรม**. Choose multiple choice, true/false, or typed blanks with one accepted answer per line. Typed answers compare case-insensitively with surrounding and repeated whitespace normalized. Publishing requires a complete key and positive integer points for each question.

**Copy AI template** generates a prompt with topic and grade level. **Import from AI** accepts a `classroom-worksheet` version 1 JSON object directly or inside one JSON code fence, up to 1 MiB of UTF-8. It requires a `title` and 1–100 questions. Every question has `type`, `prompt`, and `points`. Use `multiple-choice` with `choices` and a 1-based `correctAnswer`, `true-false` with a boolean `correctAnswer`, or `fill-in-the-blank` with an `acceptedAnswers` list. Review the questions, answers and score total before creating the private draft. The same format works in a lesson pack (MOD-005).

Publish a worksheet, choose a classroom under **มอบหมายกิจกรรมให้ห้องเรียน**, and create a round. Optionally link a published lesson assigned to that classroom. Open the round when ready. The round keeps its original content and maximum even when the library worksheet changes.

Students open the activity from their dashboard or inside the linked lesson. Both use one attempt for that roster membership. Answers autosave with a revision check. Explicit submission grades once and displays the total; students never receive answer keys. Closing prevents additional submissions and leaves unfinished drafts ungraded. Create a new round for another attempt.

Teachers see roster progress, submitted answers and scores. Submitted scores also appear as read-only columns in **สมุดคะแนน** and its Excel export. Zero is a score. Removing a lesson link or unassigning it from the classroom preserves the round, attempts and marks. Permanent student removal deletes that student's attempts only in the selected classroom.

## Dependencies and code map

Depends on MOD-001 (student sessions), MOD-002 (teacher ownership and membership), and MOD-005 (optional lesson embedding). Consumed by MOD-008 (gradebook).

- UI and workflows: `web/src/WorksheetLibrary.tsx`, `web/src/WorksheetActivity.tsx`, `web/src/StudentLearning.tsx`
- API and validation: `src/routes/worksheets.ts`, `src/worksheet-core.ts`
- AI worksheet import: `web/src/AiImportPanel.tsx`, `src/lesson-pack-import.ts`, `POST /api/worksheets/import`
- Data: `src/db/migrations/027_classroom_lessons_worksheets.sql`
- Tests: `src/worksheet-core.test.ts`, `src/student-workflow.test.ts`

## Warnings and open questions

- Closing a round is final. Any answers saved as drafts remain ungraded.
- OPEN QUESTION: Should teachers be able to override automatic grades for valid typed answers that were omitted from the accepted list?
