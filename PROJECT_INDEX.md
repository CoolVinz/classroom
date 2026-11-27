# Project Documentation Index

AI entry point. Read `AI_CONTEXT.md`, then open only the documents relevant to the task. The implemented app has eight functional modules.

## Project documents

| ID | Name | File | Purpose | Tags | Coupling | Risk | Related |
|---|---|---|---|---|---|---|---|
| PROJ-001 | Overview | [docs/PROJ-001-overview.md](docs/PROJ-001-overview.md) | Users, capabilities, and main workflows | `project, workflows` | LOW | LOW | MOD-001, MOD-002, MOD-003, MOD-004, MOD-005, MOD-006, MOD-007, MOD-008, MOD-009 |
| PROJ-002 | AI context rules | [AI_CONTEXT.md](AI_CONTEXT.md) | Selective retrieval and documentation rules | `AI, retrieval` | LOW | LOW | TEC-003 |
| DAT-001 | Data model | [docs/DAT-001-data-model.md](docs/DAT-001-data-model.md) | Entities, relationships, and ownership | `PostgreSQL, data, ownership, quiz-attempts, gallery, gradebook` | LOW | LOW | MOD-002, MOD-003, MOD-004, MOD-005, MOD-006, MOD-007, MOD-008, MOD-009 |
| TEC-001 | Architecture | [docs/TEC-001-architecture.md](docs/TEC-001-architecture.md) | Current React, Elysia, Colyseus, and database architecture | `React, Elysia, Colyseus, uploads, workers, lessons, quizzes, gradebook` | LOW | LOW | MOD-001, MOD-002, MOD-003, MOD-004, MOD-005, MOD-006, MOD-007, MOD-008, MOD-009 |
| TEC-002 | Project profile | [PROJECT_PROFILE.md](PROJECT_PROFILE.md) | Stack, commands, constraints, and debt | `stack, tooling, constraints` | LOW | LOW | TEC-001, OPS-001, MOD-004, MOD-005, MOD-006, MOD-007 |
| TEC-003 | Module template | [docs/MODULE_TEMPLATE.md](docs/MODULE_TEMPLATE.md) | Format for future module documentation | `template, Code Map` | LOW | LOW | PROJ-002 |
| OPS-001 | Deployment | [docs/OPS-001-deployment.md](docs/OPS-001-deployment.md) | App and separate Colyseus Coolify deployment requirements | `Docker, Coolify, Colyseus, operations` | LOW | LOW | TEC-001, DAT-001, MOD-005, MOD-006, MOD-007 |
| OPS-002 | Coolify and PostgreSQL deployment guide | [COOLIFY-POSTGRES-DEPLOYMENT-GUIDE.md](COOLIFY-POSTGRES-DEPLOYMENT-GUIDE.md) | Copy-ready deployment checklist for other projects | `Coolify, PostgreSQL, TLS, deployment` | LOW | LOW | OPS-001, TEC-001, DAT-001 |
| REQ-001 | Virtual world gallery | [docs/REQ-001-virtual-world-gallery.md](docs/REQ-001-virtual-world-gallery.md) | Gallery requirements and deployment limits | `gallery, student-work, Colyseus` | LOW | LOW | MOD-002, MOD-004, MOD-007, DAT-001 |
| REQ-002 | Wio Terminal labs | [docs/REQ-002-wio-terminal-labs.md](docs/REQ-002-wio-terminal-labs.md) | Build and import Wio lessons with embedded Arduino labs and private sketch submissions | `Wio Terminal, Arduino, simulation, lab, AI-import` | LOW | LOW | MOD-004, MOD-005, MOD-008 |

Project-document rows are rated LOW/LOW; module rows below describe implementation coupling and risk.

## Functional modules

| ID | Name | File | Purpose | Tags | Coupling | Risk | Related |
|---|---|---|---|---|---|---|---|
| MOD-001 | Authentication and accounts | [docs/MOD-001-authentication.md](docs/MOD-001-authentication.md) | Teacher passwords, Google student identity, sessions, and access checks | `auth, Google, Workspace, sessions` | HIGH | HIGH | MOD-002, MOD-003, MOD-004, MOD-006, DAT-001 |
| MOD-002 | Classrooms, rosters, and groups | [docs/MOD-002-classrooms-rosters.md](docs/MOD-002-classrooms-rosters.md) | Roster import/removal, classroom numbers, and teacher/student group sets | `classrooms, students, group-sets, random-assignment, CSV, XLSX` | MEDIUM | HIGH | MOD-001, MOD-003, MOD-004, MOD-006, DAT-001 |
| MOD-003 | Scheduled daily attendance and summaries | [docs/MOD-003-attendance.md](docs/MOD-003-attendance.md) | Weekly timetable, student arrival/visible-time tracking, teacher review/finalization, and daily summaries | `attendance, timetable, arrival, visible-time, reports` | HIGH | HIGH | MOD-001, MOD-002, DAT-001 |
| MOD-004 | Assignments, files, and marking | [docs/MOD-004-assignments-files.md](docs/MOD-004-assignments-files.md) | Private submissions, Wio Terminal labs, model previews, marking, and shared storage | `assignments, Arduino, Wio, submissions, assessments, storage` | HIGH | HIGH | MOD-001, MOD-002, MOD-006, MOD-008, DAT-001, TEC-001, REQ-001, REQ-002 |
| MOD-005 | Shareable lesson library | [docs/MOD-005-lessons.md](docs/MOD-005-lessons.md) | Teacher-owned block or HTML/CSS/JavaScript lessons and cross-class image manager | `lessons, classroom-assignment, public-links, code, sandbox, images, Google Drive` | HIGH | HIGH | MOD-001, MOD-002, MOD-003, MOD-006, MOD-009, DAT-001, TEC-001, OPS-001 |
| MOD-006 | Quiz builder | [docs/MOD-006-quizzes.md](docs/MOD-006-quizzes.md) | Reusable quizzes, immutable classroom rounds, private attempts, automatic scoring, and released solutions | `quizzes, attempts, scoring, timers, images, privacy` | HIGH | HIGH | MOD-001, MOD-002, MOD-005, MOD-008, DAT-001, OPS-001 |
| MOD-007 | Virtual classroom gallery | [docs/MOD-007-virtual-gallery.md](docs/MOD-007-virtual-gallery.md) | Colyseus world, student displays, train, rides, patrol, and point shop | `gallery, Colyseus, Three.js, vehicles, patrol, jail, Santa, virtual-points, vote-rewards, shop, avatars` | HIGH | HIGH | MOD-001, MOD-002, MOD-003, MOD-004, DAT-001, OPS-001 |
| MOD-008 | Class gradebook | [docs/MOD-008-gradebook.md](docs/MOD-008-gradebook.md) | Class roster grade grid for published assignment marks, completed quizzes, worksheets, and manual score columns | `gradebook, class-scores, manual-marks, totals, Excel` | HIGH | HIGH | MOD-002, MOD-004, MOD-006, MOD-009, DAT-001 |
| MOD-009 | Worksheet activities | [docs/MOD-009-worksheets.md](docs/MOD-009-worksheets.md) | Classroom worksheets with AI draft import, resumable answers, lesson embedding, and automatic grading | `worksheets, AI-import, lesson-activities, typed-answers, scores` | HIGH | HIGH | MOD-002, MOD-005, MOD-008, DAT-001 |
| MOD-010 | Live classroom activities | [docs/MOD-010-live-activities.md](docs/MOD-010-live-activities.md) | Teacher-hosted 2D quiz rooms, moderated ideas, and lesson recaps | `live-activities, avatars, Colyseus, quiz, brainstorming, recap` | HIGH | HIGH | MOD-001, MOD-003, MOD-005, MOD-006, MOD-007, MOD-008, DAT-001, OPS-001 |

## Retrieval

```text
PROJECT_INDEX.md → relevant module → Code Map → source paths → existing tests (if present)
```
