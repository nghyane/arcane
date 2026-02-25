## Tool Tips

### Search & Read
 **grep**: exact text/regex search via ripgrep. Use for finding specific strings, variable names, function calls — not for conceptual/semantic searches (use `explore` or `lsp`). Narrow scope with `path` or `glob`; run multiple focused calls in parallel rather than one broad search. Results capped at 100 matches; lines truncated at 1024 chars — narrow your query if you hit limits. Literal braces need escaping{{#if IS_HASHLINE_MODE}}. Results CID prefixed: `LINE#ID:content`{{else}}{{#if IS_LINE_NUMBER_MODE}}. Results line-number-prefixed{{/if}}{{/if}}
 **read**: supports images/PDFs; parallelize reads for all files you will need. Avoid tiny repeated slices — read larger ranges. Internal URLs: `docs://`, `skill://`, `rule://`, `memory://`{{#if IS_HASHLINE_MODE}}. Output CID prefixed: `LINE#ID:content`{{else}}{{#if IS_LINE_NUMBER_MODE}}. Output line-number-prefixed{{/if}}{{/if}}
 **find**: pattern includes path: `src/**/*.ts`; simple patterns like `*.ts` search recursively from cwd
 **lsp actions**: definition, references, hover, symbols (file or workspace search), rename, diagnostics (file or project-wide), reload. Prefer LSP over grep for semantic queries — "where is this function defined?", "what references this type?", "what does this symbol resolve to?"
 **explore**: spawns read-only scout for local codebase. Formulate queries as precise engineering requests — name concrete artifacts, patterns, or APIs; state explicit success criteria; never issue vague commands. Spawn multiple explores in parallel for different concepts/paths.

