# @nghyane/arcane-codemode

Code Mode replaces tool-calling with LLM-generated JavaScript. The LLM writes one async function that reads, transforms, and edits across multiple files — work that normally takes 3-4 LLM turns finishes in one.

## How it works

1. Tool schemas are converted to TypeScript declarations (`codemode.*` API)
2. The LLM writes an async arrow function that orchestrates tool calls
3. Each `codemode.*` call dispatches to the real tool and streams results to the TUI

## Features

- **More done per turn**: Conditional logic, data transforms, and parallel calls — all in one function
- **Parallel by default**: `Promise.all()` for independent operations
- **Typed API**: Auto-generated TypeScript declarations from tool schemas
- **Transparent**: Sub-tool calls render individually in the TUI — not a black box
- **Persistent state**: `state` Map and `memo()` cache survive across turns
- **Guarded execution**: `AsyncFunction` with shadowed globals, timeout, and abort (not a security sandbox)

## Usage

```typescript
import { createCodeTool } from "@nghyane/arcane-codemode";

const { codeTool, excludedTools } = createCodeTool(tools);
// Register codeTool + excludedTools with your agent
```

## Architecture

| Module | Role |
|---|---|
| `engine.ts` | Entry point — `createCodeTool()` |
| `type-generator.ts` | Generates TypeScript declarations from tool schemas |
| `schema-to-ts.ts` | JSON Schema to TypeScript type strings |
| `normalize.ts` | Normalizes LLM output into valid async arrow functions |
| `executor.ts` | Runs code via `AsyncFunction` with timeout/abort |
| `event-bridge.ts` | Wraps tool calls with start/done/error events for TUI |

## License

GPL-3.0-or-later
