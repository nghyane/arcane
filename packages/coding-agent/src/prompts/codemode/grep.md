# Grep

Regex search across files. Use over bash grep.
- Pattern syntax uses ripgrep — literal braces need escaping
{{#if IS_HASHLINE_MODE}}
- Results are CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Results are line-number-prefixed
{{/if}}
{{/if}}
- For semantic queries (definition, references, type info) use `lsp` instead
- For open-ended searches requiring multiple rounds, use task/explore instead
