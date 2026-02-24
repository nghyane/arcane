# Grep

Regex search across files. Use over bash grep.
- Supports full regex syntax (e.g., `log.*Error`, `function\\s+\\w+`)
- `glob` filters by file pattern (`*.ts`, `**/*.tsx`), `type` filters by extension (`ts`, `py`, `rust`)
- Pattern syntax uses ripgrep — literal braces need escaping
- Use `pre`/`post` for context lines, `multiline: true` for cross-line patterns
- `offset`/`limit` for pagination (default limit: 100)
{{#if IS_HASHLINE_MODE}}
- Results are CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Results are line-number-prefixed
{{/if}}
{{/if}}
- For semantic queries (definition, references, type info) use `lsp` instead
- For open-ended searches requiring multiple rounds, use task/explore instead