# MOD-010 — Live Classroom Activities

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

Teachers open **กิจกรรมสด** under a classroom and choose an existing published quiz or a discussion prompt. The room link is shareable with its roster. Students can also join from their classroom or a linked assigned lesson. The 2D room uses saved gallery appearances, keyboard and touch movement, and a button for each answer area. It supports 50 students and one owning teacher.

- A quiz session snapshots the published questions, images, explanations, and points. The host starts one question at a time. Students can see classmates' movement and switch areas. Server-confirmed position selects a choice until the deadline or manual lock. Leaving all answer areas saves a blank. Rejoining restores the last saved choice.
- The quiz timer starts at 30 seconds per question by default. The host chooses 10–120 seconds before creating the lobby. After lock, the app reveals the correct answer, reasoning, and answer counts. Individual scores are private. A completed quiz is practice until the teacher includes it in the gradebook. Joined students receive zero for unanswered questions. Students who never joined have a blank grade.
- Each discussion accepts up to three short text ideas per student. Teachers see authors and may approve or hide any idea. Classmates see approved ideas without author names. The session closes when the teacher publishes a recap. The recap remains in class history and in the lesson if it is still assigned.
- A classroom has one active activity at a time. Teachers can cancel an unfinished session. Quiz trash cancels active sessions and hides history. Restoration restores finished history, and permanent quiz deletion removes sessions and their results. Roster removal cascades to that student's participation, choices, and ideas in that class.

## Code map

- Elysia state, teacher controls, authorization, reveal, and scoring in `src/routes/live-activities.ts`
- Colyseus admission, movement, and server-validated choices in `gallery-server/src/live-activities.mjs`
- 2D room and host/student workflow in `web/src/LiveActivityPage.tsx`, `web/src/LiveActivityArena.tsx`, and `web/src/LiveActivityLinks.tsx`
- Durable sessions, participants, ideas, choices, and tickets in migration `035_live_activities.sql`
- Isolated PostgreSQL and 50-client verification with `bun test ./src/live-activities.integration.ts`

## Boundaries

Colyseus holds current avatar positions in memory. PostgreSQL holds deadlines, confirmed selections, ideas, and results. A room reconnect restores persisted activity state. Quiz and recap state refreshes through authenticated HTTP while avatar movement synchronizes via WebSocket on the existing gallery service. Attendance follows the regular focus, visibility, and timetable rules.

**Dependencies** MOD-001, MOD-002, MOD-003, MOD-005, MOD-006, MOD-007, MOD-008, DAT-001, OPS-001
