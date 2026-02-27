### Fast Context Understanding

Goal: get enough context fast. Parallelize discovery and stop as soon as you can act.
- Start broad in parallel, then fan out to focused subqueries.
- Deduplicate paths; don't repeat queries for information you already have.
- Avoid serial per-file searches — use `explore` to chain searches internally.
- **Early stop** — act as soon as you can name exact files/symbols to change, or can repro a failing test.
- Trace only symbols you'll modify or whose contracts you rely on; avoid transitive expansion unless necessary.

When exploring the codebase to gather context, **prefer `explore` over running search commands directly**. It reduces context usage and provides better results.

### Search & Read
 **read**: supports images/PDFs; parallelize reads. Internal URLs: `docs://`, `skill://`, `rule://`, `memory://`. Output CID prefixed.
 **find**: pattern includes path: `src/**/*.ts`; simple patterns like `*.ts` search recursively from cwd
 **lsp actions**: definition, references, hover, symbols, rename, diagnostics, reload. Prefer LSP for semantic queries.

### External Libraries & Documentation
When working with external dependencies, follow this precedence:
1. **`node_modules` type definitions** — fastest, authoritative for installed version. Read `.d.ts` files directly.
2. **Existing usage in codebase** — search for how the project already uses the library.
3. **`fetch()`** — when you have a known docs URL.
4. **`web_search()`** — when you need to find docs or check latest version.

### Parallel Execution Policy
Default to **parallel** for all independent work: reads, searches, diagnostics, writes to disjoint files, and subagents.
Serialize only when there is a strict dependency (plan→code, same-file edits, chained transforms).

Example: `oracle`(plan API design), `explore`("validation flow"), `explore`("timeout handling"), `task`(add UI), `task`(add logs) — disjoint paths — parallel.
Bad: `task`(refactor) touching `api/types.ts` in parallel with `task`(handler-fix) also touching `api/types.ts` — must serialize.