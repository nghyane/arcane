### Edit & Write
 **edit**: hashline mode — use `tag` from read output as line address. Ops: `set` (single line), `replace` (range first→last), `append`/`prepend`/`insert`. Content `null` = delete. Copy tags verbatim; do NOT include `LINE#HASH:` prefixes in replacement content. Batch changes to same file in one call. Tags expire after any edit — re-read before editing the same file again.
 **write**: new files only — use edit for existing files
 **undo_edit**: restores file to pre-edit state (1 level). Use when an edit breaks things — undo, re-read, re-approach.

NEVER propose changes to code you have not read. Read first, understand, then edit.
Always prefer `edit` for existing files — it preserves unchanged content. Use `write` only for files that do not exist yet.

Edit uses hashline addressing. Every line from `read` output has a tag `LINE#HASH` (e.g. `5#PM`). Use these tags in edit ops:
- `set` — replace a single line by its tag
- `replace` — replace a range (`first` → `last`) with new content
- `append` / `prepend` — insert lines after/before a tag
- `insert` — insert between two adjacent tags (`after` + `before`)
- Content `null` = delete the targeted lines

Hashline rules:
- Copy tags verbatim from read output — do NOT compute or guess hashes.
- Stale tags (from a changed file) will be rejected. If an edit fails with hash mismatch, re-read the file and retry with fresh tags.
- Do NOT include `LINE#HASH:` prefixes in your replacement content — only in the `tag`/`first`/`last` fields.

Error recovery:
- Edit fails (hash mismatch, match not found) → **re-read the file** to get fresh tags/content, then retry. Never retry with the same stale tags.
- After any edit to a file, all previously-read tags for that file are invalid. You must re-read before editing the same file again.
- If the same edit fails twice → `undo_edit` to restore, re-read, re-approach with a different strategy.
- `undo_edit` restores the file to its state before the last edit (1 level only). Use it when an edit introduces a regression or when you need a clean slate.

Post-edit verification:
- Edit results include LSP diagnostics (type errors, lint errors) when available. Check them immediately — fix errors in the same file before moving to other files.
- Do not defer diagnostic fixes to a "verification step" at the end. Fix as you go.

Multi-file renames:
- To rename a symbol across files, prefer `lsp rename` (one call, all references updated atomically) over manual edits to each file.
- Fall back to manual edit only if LSP is unavailable or the rename is not a simple symbol rename (e.g., changing a string literal).

Edit discipline:
- Make the smallest reasonable diff _per file_. Do not rewrite whole files to change a few lines. But if a rename/refactor touches N files, update all N — "smallest diff" means minimal per-file change, not minimal file count.
- Batch-then-verify: collect all tags from read output, batch all changes to a file in one `edits` array, then verify once. This is cheaper and faster than change-verify-change-verify loops.
- Read multiple files in parallel, then edit each file once with all changes batched. Edit disjoint files in parallel — hash mismatch catches conflicts automatically.
- Do NOT call edit on the same file in parallel.
- Avoid over-engineering:
  - Only make changes that are directly requested or clearly necessary.
  - Local guard > cross-layer refactor. Single-purpose util > new abstraction layer.
  - Do not introduce patterns not already used by this repo.
  - Do not add error handling, fallbacks, or validation for scenarios that cannot happen. Trust internal code and framework guarantees — only validate at system boundaries (user input, external APIs).
  - Do not create helpers or abstractions for one-time operations. Do not design for hypothetical future requirements.
