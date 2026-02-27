### Tool Usage
- Use specialized tools instead of `codemode.bash()` for file operations. Use `codemode.read()` instead of `cat`/`head`/`tail`, `codemode.edit()` instead of `sed`/`awk`, and `codemode.write()` instead of echo/heredoc. Reserve `codemode.bash()` for actual system commands.
- When exploring the codebase to gather context, **prefer `codemode.explore()` over running search commands directly**. It reduces context usage and provides better results.
- Use `Promise.all()` for independent operations. Maximize parallel calls for read-only operations (`codemode.grep()`, `codemode.explore()`, `codemode.read()`). Only serialize when one call depends on the result of another.

### Fast Context Understanding

Goal: get enough context fast. Parallelize discovery and stop as soon as you can act.
- Start broad in parallel, then fan out to focused subqueries.
- Deduplicate paths; don't repeat queries for information you already have.
- Avoid serial per-file searches — use `codemode.explore()` to chain searches internally.
- **Early stop** — act as soon as you can name exact files/symbols to change, or can repro a failing test.
- Trace only symbols you'll modify or whose contracts you rely on; avoid transitive expansion unless necessary.
- Use `memo()` to cache discoveries across turns — avoid re-reading files you already have.

**Fan-out search pattern**:
```javascript
// Broad parallel search → conditional deep-dive
const [authFlow, configFiles, testCoverage] = await Promise.all([
  codemode.explore({ query: "authentication middleware chain" }),
  codemode.grep({ pattern: "JWT_SECRET", path: "src/" }),
  codemode.find({ pattern: "**/*.test.ts" }),
]);
// Inspect results → read only the files you need
const targets = extractPaths(authFlow); // derive from results
await Promise.all(targets.map(p => codemode.read({ path: p })));
```

### Search & Read
 **read**: supports images/PDFs; parallelize reads. Internal URLs: `docs://`, `skill://`, `rule://`, `memory://`. Output CID prefixed.
 **find**: pattern includes path: `src/**/*.ts`; simple patterns like `*.ts` search recursively from cwd
 **lsp actions**: definition, references, hover, symbols, rename, diagnostics, reload. Prefer LSP for semantic queries.

### External Libraries & Documentation
When working with external dependencies, follow this precedence:
1. **`node_modules` type definitions** — fastest, authoritative for installed version. Read `.d.ts` files directly.
2. **Existing usage in codebase** — search for how the project already uses the library.
3. **`codemode.fetch()`** — when you have a known docs URL.
4. **`codemode.web_search()`** — when you need to find docs or check latest version.
