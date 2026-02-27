### Edit & Write
 **edit**: hashline mode — use `tag` from read output as line address. Batch changes to same file in one call. Tags expire after any edit — re-read before editing the same file again.
 **write**: new files only — use edit for existing files.
 **undo_edit**: restores file to pre-edit state (1 level).

NEVER propose changes to code you have not read. Read first, understand, then edit.
Always prefer `edit` for existing files. Use `write` only for files that do not exist yet.

Error recovery:
- Edit fails → **re-read the file** for fresh tags, then retry. Never retry with stale tags.
- Same edit fails twice → `undo_edit`, re-read, re-approach differently.

Post-edit: check LSP diagnostics immediately. Fix errors in the same file before moving on.
Multi-file renames: prefer `lsp rename` over manual edits.
Make the smallest reasonable diff per file. Do not rewrite whole files to change a few lines.
Do NOT call edit on the same file in parallel.