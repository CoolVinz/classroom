# AI Context & Documentation Rules

## Purpose

This project uses selective context retrieval to reduce unnecessary AI token usage.

The AI should retrieve only the documentation and source code required for the current task.

Do not read the entire repository or all documentation unless genuinely necessary.

---

# 1. Required Retrieval Workflow

For every development task:

1. Read `PROJECT_INDEX.md`.
2. Identify the module IDs relevant to the task.
3. Read only those module documents.
4. Read `PROJECT_PROFILE.md` only when technical, environment, architecture, or tooling information is required.
5. Use module Code Maps to locate implementation files.
6. Read only relevant source files.
7. Read relevant tests.
8. Expand context to dependencies only when required.

Preferred flow:

```text
User Task
   ↓
PROJECT_INDEX.md
   ↓
Relevant Module IDs
   ↓
Relevant Module Docs
   ↓
Code Map
   ↓
Relevant Source Files
   ↓
Relevant Tests
```

Avoid:

```text
User Task
   ↓
Read all docs
   ↓
Scan entire repository
   ↓
Read unrelated files
```

---

# 2. Context Budget

Use the smallest context that can safely solve the task.

Prefer:

```text
PROJECT_INDEX.md
+ 1–3 relevant module documents
+ relevant source files
+ relevant tests
```

Do not load unrelated modules merely for background information.

If more context becomes necessary, expand progressively.

---

# 3. Existing / Legacy / Unrefactored Projects

The existing code may contain:

- technical debt
- duplicated logic
- mixed responsibilities
- hidden dependencies
- legacy patterns
- unfinished refactoring

Do not automatically fix these issues.

Treat existing behavior as intentional until evidence shows otherwise.

Before modifying shared or uncertain code:

1. Search for usages.
2. Check related modules.
3. Check relevant tests.
4. Check database/API dependencies.
5. Preserve existing behavior unless the current task explicitly changes it.

---

# 4. Refactoring Rules

Do not refactor unrelated code while completing a task.

Do not automatically:

- rename unrelated files
- reorganize folders
- replace frameworks
- replace libraries
- change database structure
- consolidate duplicated logic
- rewrite working modules
- introduce new architecture

unless required by the task.

Prefer small and controlled changes.

---

# 5. Source of Truth

Default priority:

```text
1. Current user request
2. Explicit approved business rules / decisions
3. Current implementation
4. Existing tests
5. Documentation
6. Technical assumptions
```

For retrofitted projects, code is initially the source of truth.

A document may explicitly declare:

```text
source_of_truth: documentation
```

when it has been verified and approved.

If code and documentation conflict, identify the conflict instead of silently choosing one.

---

# 6. Documentation IDs

Use stable IDs.

```text
PROJ-xxx   Project-wide information
MOD-xxx    Functional module
REQ-xxx    Functional requirement
RULE-xxx   Business rule
DAT-xxx    Data/database
API-xxx    API contract
UI-xxx     UI/UX
TEC-xxx    Architecture/technical
SEC-xxx    Security
OPS-xxx    Deployment/operations
INT-xxx    External integration
DEC-xxx    Important decision
```

Prefer:

```text
See MOD-005.
Depends on RULE-012.
Database: DAT-003.
```

instead of vague references.

---

# 7. Module Coupling

Modules may have:

```text
LOW
MEDIUM
HIGH
```

## LOW

Mostly independent.

## MEDIUM

Shares some data/services.

## HIGH

Business behavior crosses several modules or shared infrastructure.

For HIGH-coupling modules, inspect documented dependencies before changes.

---

# 8. Module Risk

Use:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

High-risk examples:

- authentication
- payments
- stock/inventory
- accounting
- permissions
- destructive actions
- data migrations

Use broader verification for HIGH/CRITICAL areas.

---

# 9. Code Maps

Each module document should contain a concise Code Map.

Example:

```text
UI
- src/app/products/page.tsx

API
- src/app/api/products/route.ts

Services
- src/services/product-service.ts

Database
- prisma/schema.prisma

Tests
- tests/products.test.ts
```

Use the Code Map as the first navigation path.

It is not necessarily exhaustive.

---

# 10. Dependency Discovery

Module documents may contain:

```text
dependencies:
- MOD-005
- RULE-003

used_by:
- MOD-008
```

Do not recursively load every dependency.

Read a dependency only when the current task interacts with it.

---

# 11. Shared Code Safety

Before modifying:

- authentication
- middleware
- shared services
- global utilities
- shared schemas
- shared UI components
- global state
- database helpers
- common hooks

search the repository for usages.

Shared code may affect modules not explicitly documented.

---

# 12. Database Changes

Before changing a database:

1. Read relevant DAT/module docs.
2. Inspect the current schema.
3. Inspect existing migrations.
4. Search usages of affected entities/fields.
5. Check API dependencies.
6. Check validation.
7. Check relevant tests.

Do not remove or rename existing fields without checking usage.

---

# 13. API Changes

Before changing an API:

1. Read relevant API/module docs.
2. Inspect server implementation.
3. Search clients consuming the API.
4. Check request validation.
5. Check response structure.
6. Check relevant tests.

Avoid accidental breaking changes.

---

# 14. UI Changes

Before changing workflow/UI behavior:

1. Read relevant UI/module docs.
2. Identify involved components.
3. Identify API/data dependencies.
4. Preserve existing workflow unless explicitly changing it.

Do not redesign unrelated UI during a functional task.

---

# 15. Business Rules

Business rules should be explicit where possible.

Example:

```text
RULE-014

A completed order cannot be deleted.
```

Do not invent business rules.

If intent cannot be determined:

```text
OPEN QUESTION
```

Record the question instead of guessing.

---

# 16. Automatic Documentation Maintenance

After completing a task, determine whether the task permanently changed:

- business behavior
- business rule
- workflow
- API contract
- database structure
- module dependency
- architecture
- authentication/security behavior
- external integration
- deployment behavior
- important technical decision

If YES:

Update only the affected documentation.

If NO:

Do not modify documentation.

Do not regenerate the complete documentation set after each task.

---

# 17. Documentation That Usually Does NOT Need Updating

Do not update permanent documentation for:

- typo fixes
- small CSS changes
- button spacing
- temporary logs
- temporary debugging
- formatting-only changes
- simple internal cleanup with no behavioral impact

---

# 18. PROJECT_INDEX Maintenance

Update `PROJECT_INDEX.md` only when:

- a major module is added
- a module is removed
- a module is renamed
- module responsibility changes
- major dependencies change
- a document is deprecated
- a new important domain is introduced

Keep the index concise.

The index tells AI where information is located.

It should not contain full specifications.

---

# 19. New Feature Workflow

```text
Request
   ↓
PROJECT_INDEX
   ↓
Relevant modules/rules
   ↓
Relevant code
   ↓
Dependencies
   ↓
Implementation
   ↓
Tests
   ↓
Update affected docs if needed
```

---

# 20. Bug Fix Workflow

```text
Bug
   ↓
Identify responsible module
   ↓
Read module docs
   ↓
Inspect relevant implementation
   ↓
Search usages/dependencies
   ↓
Make smallest safe fix
   ↓
Test
   ↓
Document permanent discoveries if useful
```

Do not refactor an entire module merely because the bug exposed messy code.

---

# 21. Explicit Refactoring Workflow

When refactoring is specifically requested:

1. Document existing behavior.
2. Identify dependencies.
3. Identify affected tests.
4. Preserve external behavior unless explicitly changing it.
5. Refactor in bounded steps.
6. Update Code Maps.
7. Update architecture/dependency docs where necessary.
8. Record important decisions.

---

# 22. Task Completion Checklist

Before considering a task complete:

- [ ] Relevant modules were identified.
- [ ] Relevant requirements/business rules were checked.
- [ ] Dependencies were checked when applicable.
- [ ] Shared-code usages were searched when applicable.
- [ ] Existing behavior was preserved unless intentionally changed.
- [ ] Relevant tests were checked or added.
- [ ] Only necessary source files were modified.
- [ ] Permanent documentation changes were updated.
- [ ] Unrelated documentation was not regenerated.

---

# 23. Core Principle

Context should expand only when necessary.

Always prefer:

```text
Index
→ Relevant docs
→ Relevant code
→ Dependencies if necessary
```

over:

```text
Entire project
→ Entire documentation
→ Entire repository history
```
