# MOD-008 — Class Gradebook

**Status:** Implemented  
**Coupling:** HIGH  
**Risk:** HIGH

## Purpose and behavior

Give teachers one class-level view of scores from published assignment assessments, completed quiz attempts, submitted worksheet activities, and manually created score columns. Students cannot access this view. Assignment drafts and unfinished quiz or worksheet attempts have no grade. Worksheet scores are read-only here and use the round’s fixed maximum.

Completed live quiz scores appear when the teacher enables gradebook inclusion for the session. The session's saved quiz controls the maximum. Participants have recorded grades including zero, and students who never joined have blank cells. See MOD-010.

Teachers can create a manual score item with a name and maximum, edit scores for the roster, save a whole column atomically, and archive or restore manual columns. A blank clears a saved manual score; `0` is an explicit score. Revision checks reject stale column saves. Archived students and archived items can be included through a filter; their records remain available.

Teachers choose which visible items contribute to each student's total. The gradebook adds earned points over the maximum points for recorded selected items only. Published assignment maximum snapshots are used, so changes to a later assignment maximum do not alter previously published grades. A student with no recorded marks has no total. Excel export uses the current roster/item filters, selected items, individual score denominators, and totals.

## Dependencies and consumers

**dependencies:** MOD-002, MOD-004, MOD-006, MOD-009, DAT-001
**used_by:** teacher classroom score review and Excel export

**Code Map:**

```text
Teacher classroom tab and score grid: web/src/App.tsx, web/src/ClassGradebook.tsx
Total calculation and checks: web/src/gradebook.ts, web/src/gradebook.test.ts
Teacher-only read and manual score APIs: src/routes/gradebook.ts
Published assignment assessment source: src/routes/coursework.ts, classroom.assignment_assessments
Completed quiz result source: src/routes/quizzes.ts, classroom.quiz_attempts
Submitted worksheet source: src/routes/worksheets.ts, classroom.worksheet_attempts
Manual score tables: src/db/migrations/019_gradebook.sql
Migration runner: src/db/bootstrap.ts
```

## Technical debt and warnings

- Totals add points, so teachers should choose comparable score items and exclude practice work when needed. The inclusion selection is a view setting and is not saved across reloads.
- There is no term-level grade calculation, weighting, letter-grade conversion, student-facing gradebook, or audit history for manual score edits.
- Assignment drafts are intentionally excluded; teachers must publish an assessment before it appears here.

## Open questions

- Should item selection and totals be saved per teacher/classroom?
- Should manual score edits have a permanent change history?
- Do teachers need weighted categories, terms, or a student-facing grade report?
