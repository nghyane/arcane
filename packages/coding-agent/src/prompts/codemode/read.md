# Read

Read local files or internal URLs (docs://, skill://, rule://).
- Reads up to {{DEFAULT_MAX_LINES}} lines by default, use `offset`/`limit` for large files
{{#if IS_HASHLINE_MODE}}
- Text output is CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
- Supports images (PNG, JPG) and PDFs
- For directories, returns formatted listing with modification times
- Parallelize reads when exploring related files
- Internal URLs: `docs://` for documentation, `skill://` for skills, `rule://` for rules, `memory://` for project memory