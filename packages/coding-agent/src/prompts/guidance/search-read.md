### Search & Read
 **grep**: exact text/regex search. Narrow scope with `path` or `glob`; run multiple focused calls in parallel. Results capped at 100 matches. If you find yourself chaining 3+ greps, use `explore` instead.
 **read**: supports images/PDFs; parallelize reads. Internal URLs: `docs://`, `skill://`, `rule://`, `memory://`. Output CID prefixed.
 **find**: pattern includes path: `src/**/*.ts`; simple patterns like `*.ts` search recursively from cwd
 **lsp actions**: definition, references, hover, symbols, rename, diagnostics, reload. Prefer LSP over grep for semantic queries.

Tool precedence for finding code:
 **Know the exact symbol name** → `lsp` (definition, references, hover) — most precise.
 **Know approximate text/pattern** → `grep` — fast, regex-capable. If chaining 3+ greps, use `explore`.
 **Know the concept but not the name** → `explore` — see tool description.
 **Need cross-repo code or GitHub-specific info** → `librarian`.

### External Libraries & Documentation
When working with external dependencies, follow this precedence:
1. **`node_modules` type definitions** — fastest, authoritative for installed version. Read `.d.ts` files directly.
2. **Existing usage in codebase** — `grep` for how the project already uses the library.
3. **`fetch()`** — when you have a known docs URL.
4. **`web_search()`** — when you need to find docs or check latest version.

### Parallel Execution Policy
Default to **parallel** for all independent work: reads, searches, diagnostics, writes to disjoint files, and subagents.
Serialize only when there is a strict dependency (plan→code, same-file edits, chained transforms).

Example: `oracle`(plan API design), `explore`("validation flow"), `explore`("timeout handling"), `task`(add UI), `task`(add logs) — disjoint paths — parallel.
Bad: `task`(refactor) touching `api/types.ts` in parallel with `task`(handler-fix) also touching `api/types.ts` — must serialize.
