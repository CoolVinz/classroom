# Project Documentation Index

AI entry point. Read `AI_CONTEXT.md`, then open only the documents relevant to the task. The implemented app has four functional modules.

## Project documents

| ID | Name | File | Purpose | Tags | Coupling | Risk | Related |
|---|---|---|---|---|---|---|---|
| PROJ-001 | Overview | [docs/PROJ-001-overview.md](docs/PROJ-001-overview.md) | Users, capabilities, and main workflows | `project, workflows` | LOW | LOW | MOD-001, MOD-002, MOD-003, MOD-004 |
| PROJ-002 | AI context rules | [AI_CONTEXT.md](AI_CONTEXT.md) | Selective retrieval and documentation rules | `AI, retrieval` | LOW | LOW | TEC-003 |
| DAT-001 | Data model | [docs/DAT-001-data-model.md](docs/DAT-001-data-model.md) | Entities, relationships, and ownership | `PostgreSQL, data, ownership` | LOW | LOW | MOD-002, MOD-003, MOD-004 |
| TEC-001 | Architecture | [docs/TEC-001-architecture.md](docs/TEC-001-architecture.md) | Current React, Elysia, and database architecture | `React, Elysia, uploads, workers` | LOW | LOW | MOD-001, MOD-002, MOD-003, MOD-004 |
| TEC-002 | Project profile | [PROJECT_PROFILE.md](PROJECT_PROFILE.md) | Stack, commands, constraints, and debt | `stack, tooling, constraints` | LOW | LOW | TEC-001, OPS-001, MOD-004 |
| TEC-003 | Module template | [docs/MODULE_TEMPLATE.md](docs/MODULE_TEMPLATE.md) | Format for future module documentation | `template, Code Map` | LOW | LOW | PROJ-002 |
| OPS-001 | Deployment | [docs/OPS-001-deployment.md](docs/OPS-001-deployment.md) | Docker and Coolify deployment requirements | `Docker, Coolify, operations` | LOW | LOW | TEC-001, DAT-001 |
| OPS-002 | Coolify and PostgreSQL deployment guide | [COOLIFY-POSTGRES-DEPLOYMENT-GUIDE.md](COOLIFY-POSTGRES-DEPLOYMENT-GUIDE.md) | Copy-ready deployment checklist for other projects | `Coolify, PostgreSQL, TLS, deployment` | LOW | LOW | OPS-001, TEC-001, DAT-001 |
| REQ-001 | Virtual world gallery | [docs/REQ-001-virtual-world-gallery.md](docs/REQ-001-virtual-world-gallery.md) | Confirmed future shared world, student blocks, uploads, and likes | `gallery, student-work, future` | LOW | LOW | MOD-002, MOD-004, DAT-001 |

Project-document rows are rated LOW/LOW; module rows below describe implementation coupling and risk.

## Functional modules

| ID | Name | File | Purpose | Tags | Coupling | Risk | Related |
|---|---|---|---|---|---|---|---|
| MOD-001 | Authentication and accounts | [docs/MOD-001-authentication.md](docs/MOD-001-authentication.md) | Owner/teacher accounts, student invitations, sessions, and recovery | `auth, students, sessions, email` | HIGH | HIGH | MOD-002, MOD-003, MOD-004, DAT-001 |
| MOD-002 | Classrooms and student rosters | [docs/MOD-002-classrooms-rosters.md](docs/MOD-002-classrooms-rosters.md) | Teacher-owned classrooms, roster import/edit, and student invitations | `classrooms, students, email, CSV, XLSX` | MEDIUM | HIGH | MOD-001, MOD-003, MOD-004, DAT-001 |
| MOD-003 | Daily attendance and summaries | [docs/MOD-003-attendance.md](docs/MOD-003-attendance.md) | Daily marks, batch saves, and date-range attendance counts | `attendance, reports, dates` | HIGH | HIGH | MOD-001, MOD-002, DAT-001 |
| MOD-004 | Assignments and classroom files | [docs/MOD-004-assignments-files.md](docs/MOD-004-assignments-files.md) | Teacher worksheets/review, private student submissions, and STL/OBJ previews | `assignments, submissions, files, 3D, storage` | HIGH | HIGH | MOD-001, MOD-002, DAT-001, TEC-001, REQ-001 |

## Retrieval

```text
PROJECT_INDEX.md → relevant module → Code Map → source paths → existing tests (if present)
```
