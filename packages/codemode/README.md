# @oh-my-pi/pi-codemode

Code Mode replaces sequential tool-calling with LLM-generated JavaScript. Instead of N round-trips for N tools, the LLM writes one async function that orchestrates all calls via a typed `codemode.*` proxy API.

## Features

- **Single round-trip**: One async JS function orchestrates multiple tools
- **Parallel execution**: `Promise.all()` for independent operations
- **Typed API**: Auto-generated TypeScript declarations from tool schemas
- **Transparent rendering**: Sub-tool calls render individually in the TUI
- **Sandboxed execution**: `AsyncFunction` with shadowed globals, timeout, and abort support

## Usage

```typescript
import { createCodeTool } from "@oh-my-pi/pi-codemode";

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

MIT
