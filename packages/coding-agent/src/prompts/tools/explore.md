# Explore

Intelligently search the codebase using a specialized read-only subagent. Use for complex, multi-step search tasks where you need to find code based on functionality or concepts rather than exact matches.

## When to use
- Locate code by behavior or concept (not exact string match)
- Chain multiple searches to correlate areas of the codebase
- Answer questions like "Where is JWT authentication implemented?"
- Understand architecture or data flow across files
- Map dependencies between modules

## When NOT to use
- When you know the exact file path (use Read directly)
- When looking for a specific string/symbol (use Grep or Find)
- When you need to create/modify files (this is read-only)

## Parameters

### `query` (required)

The search query describing what you need to find. Be specific — include technical terms, file types, expected code patterns, or API names. State explicit success criteria.

## Output

Returns structured JSON with:
- `files`: files examined with exact line ranges
- `code`: critical types/interfaces/functions extracted verbatim
- `architecture`: brief explanation of how pieces connect
- `start_here`: recommended entry point for you to continue from