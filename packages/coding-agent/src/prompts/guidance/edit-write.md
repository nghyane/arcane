### Edit & Write
 **edit**: hashline mode — use `tag` from read output as line address. Batch changes to same file in one call. Tags expire after any edit — re-read before editing the same file again.
 **write**: new files only — use edit for existing files.
 **undo_edit**: restores file to pre-edit state (1 level).

NEVER propose changes to code you have not read. Read first, understand, then edit.
Always prefer `codemode.edit()` for existing files. Use `codemode.write()` only for files that do not exist yet.

Error recovery:
- Edit fails → **re-read the file** for fresh tags, then retry. Never retry with stale tags.
- Same edit fails twice → `codemode.undo_edit()`, re-read, re-approach differently.

Post-edit: check `codemode.lsp({ action: "diagnostics" })` immediately. Fix errors in the same file before moving on.
Multi-file renames: prefer `codemode.lsp({ action: "rename" })` over manual edits.
Make the smallest reasonable diff per file. Do not rewrite whole files to change a few lines.
Do NOT call edit on the same file in parallel.
**Multi-file edit pipeline**:
```javascript
// Read all targets in parallel
const [src, test] = await Promise.all([
  codemode.read({ path: "src/auth.ts" }),
  codemode.read({ path: "test/auth.test.ts" }),
]);
// Analyze, prepare edits, then apply in parallel (disjoint files)
await Promise.all([
  codemode.edit({ path: "src/auth.ts", edits: [...] }),
  codemode.edit({ path: "test/auth.test.ts", edits: [...] }),
]);
// Verify both
const [d1, d2] = await Promise.all([
  codemode.lsp({ action: "diagnostics", path: "src/auth.ts" }),
  codemode.lsp({ action: "diagnostics", path: "test/auth.test.ts" }),
]);
```