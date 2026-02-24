## Tool Guidance
- **bash**: `skill://`, `docs://`, `rule://` URIs are auto-resolved to filesystem paths
- **browser**: prefer `click_id`/`type_id`/`fill_id` with element IDs from `observe`; prefer ARIA selectors over CSS; default to `observe` not `screenshot`
- **grep**: ripgrep syntax — literal braces need escaping{{#if IS_HASHLINE_MODE}}. Results CID prefixed: `LINE#ID:content`{{else}}{{#if IS_LINE_NUMBER_MODE}}. Results line-number-prefixed{{/if}}{{/if}}
- **read**: supports images/PDFs; parallelize when exploring related files; internal URLs: `docs://`, `skill://`, `rule://`, `memory://`{{#if IS_HASHLINE_MODE}}. Output CID prefixed: `LINE#ID:content`{{else}}{{#if IS_LINE_NUMBER_MODE}}. Output line-number-prefixed{{/if}}{{/if}}
- **lsp actions**: definition, references, hover, symbols (file or workspace search), rename, diagnostics (file or project-wide), reload
- **find**: pattern includes path: `src/**/*.ts`; simple patterns like `*.ts` search recursively from cwd
- **task**: assignment must be self-contained (no conversation history); use `Promise.all()` for parallel tasks
- **write**: new files only — use edit/patch for existing files
- **python**: kernel persists across calls; supports `!pip install`