# @nghyane/arcane-codemode

Pure library for executing LLM-generated JavaScript. Provides type generation from tool schemas, code normalization, and sandboxed execution.

## Exports

| Module | Role |
|---|---|
| `executor.ts` | Runs code via `AsyncFunction` with timeout/abort |
| `type-generator.ts` | Generates TypeScript declarations from tool schemas |
| `schema-to-ts.ts` | JSON Schema to TypeScript type strings |
| `normalize.ts` | Normalizes LLM output into valid async arrow functions |

## Usage

```typescript
import { execute, generateTypes, normalizeCode } from "@nghyane/arcane-codemode";

// Generate typed API from tool schemas
const { declarations } = generateTypes(tools);

// Normalize and execute LLM-generated code
const code = normalizeCode(rawCode);
const result = await execute(code, dispatchMap, { timeoutMs: 300_000 });
```

## License

GPL-3.0-or-later
