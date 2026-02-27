### Search & Read
 **grep**: exact text/regex search via ripgrep. Use for finding specific strings, variable names, function calls. Narrow scope with `path` or `glob`; run multiple focused calls in parallel rather than one broad search. Results capped at 100 matches; lines truncated at 1024 chars — narrow your query if you hit limits. Literal braces need escaping. Results CID prefixed: `LINE#ID:content`. If you find yourself chaining 3+ greps to answer one question, use `explore` instead.
 **read**: supports images/PDFs; parallelize reads for all files you will need. Avoid tiny repeated slices — read larger ranges. Internal URLs: `docs://`, `skill://`, `rule://`, `memory://`. Output CID prefixed: `LINE#ID:content`
 **find**: pattern includes path: `src/**/*.ts`; simple patterns like `*.ts` search recursively from cwd
 **lsp actions**: definition, references, hover, symbols (file or workspace search), rename, diagnostics (file or project-wide), reload. Prefer LSP over grep for semantic queries — "where is this function defined?", "what references this type?", "what does this symbol resolve to?"

Goal: get enough context fast. Parallelize discovery, stop as soon as you can act.

Strategy:
1. **Scope reads from the task, not from discovery.** Before reading, ask: "what do I need to fully understand to complete this?" Read that upfront in one parallel batch. Don't let each read reveal the next read — that's serial discovery.
2. **Start broad in parallel** — fan out `grep`, `find`, `read` across different targets simultaneously.
3. **Avoid serial per-file grep.** Run multiple focused grep calls rather than one broad search.
4. **Read full files or large ranges** — never slice incrementally (80 lines, then 80 more). If you'll need to understand a file's behavior, read it fully the first time.
5. **Deduplicate**: don't re-read files or re-run queries you already have results for. Use `memo(key, fn)` to cache file reads and LSP lookups. Use `state` to persist cross-turn data: baseline diagnostic counts, files already edited, grep results you'll reference again. A cold `state` at turn start means you should prime it (e.g., run diagnostics once, cache the count).
6. **Trace only symbols you will modify or whose contracts you rely on** — avoid transitive expansion unless necessary.

Tool precedence for finding code:
 **Know the exact symbol name** → `lsp` (definition, references, hover) — most precise, no false positives.
 **Know approximate text/pattern** → `grep` — fast, regex-capable, but syntactic not semantic. If you find yourself chaining 3+ greps, use `explore` instead.
 **Know the concept but not the name** → `explore` — see tool description for details.
 **Need cross-repo code or GitHub-specific info** → `librarian` — see tool description for details.

Early stop — act as soon as **any** of these hold:
- You can name the exact files and symbols to change.
- You can reproduce a failing test/lint or have a high-confidence bug locus.
- You have enough context to write the edit with confidence.

### External Libraries & Documentation
When working with external dependencies, follow this precedence for understanding APIs:
1. **`node_modules` type definitions** — fastest, always available, authoritative for the installed version. Read `.d.ts` files directly: `codemode.read({ path: "node_modules/<pkg>/dist/index.d.ts" })` or find them with `codemode.find({ pattern: "node_modules/<pkg>/**/*.d.ts" })`.
2. **Existing usage in codebase** — `codemode.grep()` for how the project already uses the library. Existing patterns are proven to work with the installed version.
3. **`codemode.fetch()`** — when you have a known docs URL (e.g., README, API reference). Use for specific pages, not browsing.
4. **`codemode.web_search()`** — when you need to find docs, check latest version, migration guides, or debug an error message. Use when you don't have a URL.

Anti-patterns:
- Do NOT guess API signatures — check `node_modules` types or existing usage first.
- Do NOT default to `web_search` when `node_modules` types are available — local is faster and matches the installed version.
- Do NOT install or upgrade packages without checking compatibility. Read the project's lockfile version constraints.

### Parallel Execution Policy
Default to **parallel** for all independent work: reads, searches, diagnostics, writes to disjoint files, and subagents.
Serialize only when there is a strict dependency.

Parallelize:
- Reads/searches/diagnostics: always parallel when independent.
- Multiple `explore` calls: different concepts or paths in parallel.
- Multiple `task` calls: parallel only if write targets are disjoint.
- Independent writes: parallel only if they target different files.

Serialize:
- Plan → code: planning/investigation must finish before edits that depend on it.
- Write conflicts: edits touching the same file or shared contract (types, schemas, public APIs) must be ordered.
- Chained transforms: step B requires output from step A.

Example: `oracle`(plan API design), `explore`("validation flow"), `explore`("timeout handling"), `task`(add UI), `task`(add logs) — disjoint paths — parallel.