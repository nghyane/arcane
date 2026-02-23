# Task

Launch a fire-and-forget subagent to execute well-scoped work. Think of it as a productive junior engineer who cannot ask follow-ups once started.
- **Use for**: Multi-file implementations, cross-layer refactors, mass migrations, boilerplate generation
- **Don't use for**: Exploratory work, architectural decisions, single-file edits, reading a file

## Subagent capabilities

Subagents receive the **full system prompt**, including AGENTS.md, context files, and skills. They have no access to your conversation history — they don't know decisions you made, approaches you chose, or requirements stated only in conversation. Subagents CAN grep the parent conversation file for supplementary details.
---

## Parameters

### `context` (optional — strongly recommended)

Shared background prepended verbatim to every task `assignment`. Use only for session-specific information subagents lack.

<critical>
Do NOT include project rules, coding conventions, or style guidelines — subagents already have AGENTS.md. Restating any rule from AGENTS.md in `context` is a bug.
</critical>
**Before writing each line of context, ask:** "Would this sentence be true for ANY task in this repo, or only for THIS specific batch?" If it applies to any task → the subagent already has it → delete the line.

Use template; omit non-applicable sections:

````
## Goal
One sentence: what the batch accomplishes together.

## Non-goals
Explicitly exclude tempting scope — what tasks must not touch.

## Constraints
- Task-specific MUST / MUST NOT rules not already in AGENTS.md
- Decisions made during this session that affect implementation

## Reference Files
- `path/to/file.ext` — pattern demo

## API Contract (if tasks produce/consume shared interface)
```language
// Exact type definitions, function signatures
```

## Acceptance (global)
- Definition of "done" for batch
- For parallel tasks, build/test/lint verification happens AFTER all tasks complete — not inside tasks. Single tasks may self-verify.
````
**Belongs in `context`**: session decisions, reference paths, shared type definitions, API contracts, global acceptance — anything 2+ tasks need that isn't in AGENTS.md.
**Does NOT belong**: project rules from AGENTS.md, per-task file lists, one-off requirements (go in `assignment`).

### `tasks` (required)

Array of tasks that execute in parallel.

|Field|Required|Purpose|
|---|---|---|
|`id`|yes|CamelCase identifier, max 32 chars|
|`description`|yes|Short one-liner for UI display only — not seen by subagent|
|`assignment`|yes|Complete per-task instructions (see below)|
|`skills`||Skill names to preload. Use only when it changes correctness.|
---

## Writing an assignment

<critical>
`assignment` must contain enough info for the subagent to act **without asking a clarifying question**. One-liners guarantee failure.

Use this structure:

```
## Target
- Files: exact path(s)
- Symbols/entrypoints: specific functions, types, exports
- Non-goals: what task must NOT touch

## Change
- Step-by-step: add/remove/rename/restructure
- Patterns/APIs to use; reference files if applicable

## Edge Cases / Don't Break
- Tricky case 1: ...
- Existing behavior that must survive: ...

## Acceptance (task-local)
- Expected behavior or observable result
- For parallel tasks: DO NOT include project-wide build/test/lint commands
```

`context` carries shared background. `assignment` carries only delta: file-specific instructions, local edge cases, per-task acceptance.

### Delegate intent, not keystrokes

Your role is tech lead: set direction, define boundaries, call out pitfalls — then get out of the way. Don't dictate line-by-line edits.
**Be specific about:** constraints, naming, API contracts, "don't break" items, acceptance criteria.
**Delegate:** code reading, approach selection, exact edit locations, implementation details.
</critical>

### Anti-patterns
**Vague assignments** — subagent guesses wrong or stalls:
- "Refactor this to be cleaner."
- "Fix the bug in streaming."
- "Update all constructors in `src/**/*.ts`."
**Test/lint in parallel tasks** — edit wars:
Parallel agents share working tree. If two agents run `bun check` concurrently, they see each other's half-finished edits, "fix" phantom errors, loop. **Never tell parallel tasks to run project-wide build/test/lint.** Each task edits, stops. Caller verifies after all complete. Single-task launches may include verification.
**If you can't specify scope yet**, create a **Discovery task** first: enumerate files, find callsites, list candidates. Then fan out with explicit paths.
---

## Task scope

Each task: small, well-defined — **at most 3-5 files**.
**Signs task is too broad:** file paths use globs, assignment says "update all" / "migrate everything", scope covers entire package.
**Fix:** enumerate files first (grep/glob), then fan out one task per file or small cluster.
---

## Parallelization
**Test:** Can task B produce correct output without seeing task A's result?
- **Yes** → parallelize
- **No** → sequential (A completes, then launch B with A's output in context)

### Must be sequential

|First|Then|Reason|
|---|---|---|
|Define types/interfaces|Implement consumers|Consumers need contract|
|Create API exports|Write bindings/callers|Callers need signatures|
|Core module|Dependent modules|Dependents import from core|

### Safe to parallelize
- Independent modules, no cross-imports
- Tests for already-implemented code
- Isolated file-scoped refactors

### Multi-phase pattern
**Phase 1 — Sequential**: define shared contracts (types, interfaces, schemas).
**Phase 2 — Parallel**: fan out tasks consuming same known interface.
**Phase 3 — Integration** (do yourself): wire modules, fix mismatches, verify builds.
---

## Pre-flight checklist

Before calling tool, verify:
- [ ] `context` includes only session-specific info not already in AGENTS.md
- [ ] Each assignment has Target, Change, Edge Cases, Acceptance sections
- [ ] Assignments reference exact file paths (no globs)
- [ ] Scope small, file paths explicit
- [ ] Parallel tasks don't run project-wide build/test/lint — you do after all tasks complete (single tasks may self-verify)