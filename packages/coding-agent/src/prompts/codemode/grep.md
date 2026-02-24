# Grep

Regex search across files.
- Pattern syntax uses ripgrep — literal braces need escaping
{{#if IS_HASHLINE_MODE}}
- Results are CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Results are line-number-prefixed
{{/if}}
{{/if}}
