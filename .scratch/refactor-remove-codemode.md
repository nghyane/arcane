# Task: Remove Codemode, Migrate to Native Tool Calling

## Issue
https://github.com/nghyane/arcane/issues/49

## Goal
Remove the codemode wrapper that wraps all tools into a single "code" tool. Instead, expose all tools directly to the LLM via native tool calling. This is a large refactor across packages/coding-agent.

## Why
- Native parallel tool use (Claude, GPT, etc.) makes codemode's Promise.all pattern redundant
- buildResponse loses data visibility — LLM sees "grep: done (150ms)" instead of full grep results
- Weak models (Haiku) used by subagents can't write JS correctly
- ~1500 LOC + 25 files of unnecessary complexity
- Industry standard (Amp CLI, Claude Code) uses native tool calling

## Architecture Change

### Before
```
createTools(session, toolNames)
  → instantiate raw AgentTool[]
  → createCodeTool(tools)        // wraps ALL tools into single "code" tool
    → buildDescription(toolNames) // assembles JS API prompt from rules.md + tool snippets
    → codeTool.execute = run JS via executor.ts
  → return [codeTool]            // agent sees 1 tool

LLM writes: async () => { const x = await codemode.grep({...}); return x; }
Executor runs JS → dispatches to raw tools via Proxy
buildResponse formats result → "grep: done (150ms)\n{return value}"
```

### After
```
createTools(session, toolNames)
  → instantiate raw AgentTool[]
  → return tools                  // agent sees 20+ tools directly

LLM calls: tool_use[grep]({pattern: "...", path: "src"})
Native tool execution → full tool_result returned to LLM
```

## Files to Change

### Phase 1: Core (must do first)

#### DELETE entirely:
- `src/codemode/executor.ts` — JS sandbox executor
- `src/codemode/normalize.ts` — code string normalizer
- `src/codemode/prompt.ts` — prompt assembly (imports 23 tool snippets)
- `src/codemode/sanitize-tool-name.ts`
- `src/codemode/index.ts` — re-exports
- `src/codemode/prompts/rules.md` — 4.7KB codemode rules
- `src/codemode/prompts/tools/*.md` — 23 tool type snippet files
- `src/tools/code-tool.ts` — code tool wrapper + dispatcher + buildResponse

#### MODIFY:

**`src/tools/create-tools.ts`** — Critical change:
```typescript
// REMOVE these imports:
import { createCodeTool } from "./code-tool";

// CHANGE end of createTools():
// BEFORE (line 186-187):
const { codeTool } = createCodeTool(tools);
return [codeTool];

// AFTER:
return tools;
```

**`src/prompts/system/system-prompt.md`** — Remove codemode references:
- Line 25: Remove "All operations available via `codemode.*` API..."
- Line 61: Change "I'll call codemode.read()" to just "I'll use the read tool"
- Line 124: Change `codemode.read()`/`codemode.lsp()` to "read/lsp tools directly"
- Add tool usage guidelines (reference Amp's approach):
  - "Call multiple tools in a single response when there are no dependencies"
  - "Maximize parallel tool calls for read-only operations"
  - "Use specialized tools instead of Bash for file operations"

### Phase 2: TUI

**`src/modes/components/code-group.ts`** — This component renders codemode step/progress. Options:
- Option A: Remove entirely, rely on existing per-tool rendering
- Option B: Repurpose to group parallel tool calls visually
- Recommend Option A for simplicity

**`src/modes/controllers/event-controller.ts`** — Remove handling of:
- `step_start`, `step_end`, `step_progress` events
- `execution_abort` event
- `CodeGroupComponent` usage

**`packages/agent/src/types.ts`** — Remove event types (lines 328-332):
- `execution_abort`
- `step_start`
- `step_end`  
- `step_progress`

### Phase 3: Subagent prompts

Add output format instructions to each subagent prompt:

**`src/prompts/agents/explore.md`** — Add:
```
Your final message must contain ONLY the search results — no preamble like "I'll search for...".
```

**`src/prompts/agents/oracle.md`** — Add:
```
Your final message must contain ONLY your analysis and recommendations.
```

**`src/prompts/agents/librarian.md`** — Add:
```
Your final message must contain ONLY the information found.
```

**`src/prompts/agents/reviewer.md`** — Add:
```
Your final message must contain ONLY the review findings.
```

### Phase 4: System prompt refinement

Update `src/prompts/system/system-prompt.md` with native tool calling guidance.

Reference Amp CLI v2 prompt structure:
```
# Tool usage
- Call multiple tools in a single response when there are no dependencies
- Maximize parallel tool calls for read-only operations (grep, read, find)
- Only call tools sequentially when one depends on the result of another
- Use specialized tools instead of Bash for file operations
- Do NOT use Task tool unless genuinely requires independent, parallelizable work
- Prefer doing work directly — you retain full context and produce better results

# Parallel Execution Policy  
Default to parallel for all independent work: reads, searches, diagnostics.
Serialize only when there is a strict dependency.

## What to parallelize
- Reads/Searches/Diagnostics: independent calls
- Multiple subagents: different concerns in parallel
- Independent writes: disjoint file targets

## When to serialize
- Plan → Code: planning must finish before dependent edits
- Write conflicts: edits to same file must be ordered
- Chained transforms: step B requires artifacts from step A
```

### Phase 5: Cleanup

- Update `AGENTS.md` — remove all codemode references
- Update `packages/coding-agent/package.json` — remove codemode dep if any
- Run `bun fmt && bun check` to verify
- Update CHANGELOG.md

## Key Context

### Current tool registration (`create-tools.ts`):
20 built-in tools: ask, bash, python, ssh, edit, find, explore, github, grep, librarian, lsp, notebook, oracle, read, browser, task, code_review, todo_write, undo_edit, fetch, web_search, search_code, write

### Subagent tool configs:
- explore: read, grep, find (model: arcane/fast)
- oracle: read, grep, find, lsp (model: arcane/oracle) 
- librarian: github, fetch, web_search, search_code (model: arcane/fast)
- reviewer: read, grep, find, lsp, bash (model: arcane/reviewer)
- task: bash, python, read, find, grep, lsp, edit, write, undo_edit, fetch, web_search, todo_write (model: default)

### AgentTool interface:
```typescript
interface AgentTool<TParameters, TDetails, TTheme> extends Tool<TParameters> {
  label: string;
  hidden?: boolean;
  nonAbortable?: boolean;
  concurrency?: "shared" | "exclusive";
  execute: AgentToolExecFn<TParameters, TDetails, TTheme>;
  // ... rendering methods
}

interface Tool<TParameters> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

### Event types to remove from agent package:
```typescript
| { type: "execution_abort"; toolCallId: string; message: string }
| { type: "step_start"; toolCallId: string; stepId: string; intent: string; parentStepId?: string }
| { type: "step_end"; toolCallId: string; stepId: string; durationMs: number }
| { type: "step_progress"; toolCallId: string; stepId: string; message: string }
```

## Verification

After all changes:
1. `bun fmt` — format
2. `bun check` — typecheck + lint  
3. Verify no remaining imports of codemode, code-tool, buildDescription, createCodeTool
4. Verify agent receives AgentTool[] (not [codeTool])

## Reference: Amp CLI Smart Agent Prompt (v2)

This is how Amp (Sourcegraph, 54 tools, production) structures their main agent prompt with native tool calling — use as reference for system prompt updates:

```
# Tool usage
- Use specialized tools instead of Bash for file operations
- Call multiple tools in a single response when there are no dependencies
- Maximize parallel tool calls for read-only operations
- Only call tools sequentially when one depends on the result of another
- Do NOT use Task tool unless genuinely requires independent, parallelizable work
- Prefer doing work directly and sequentially yourself — you retain full context

# Editing files
- NEVER create files unless absolutely necessary
- Make the smallest reasonable diff
- Use edit_file for existing files, create_file only for new files

# Doing tasks
- NEVER propose changes to code you haven't read
- After making code changes, ALWAYS verify by running relevant tests/checks
- After editing, check for lint/compile errors and fix immediately
```

## Notes
- This is Phase 1 of issue #49. Focus on core removal first.
- Do NOT change tool implementations (grep, read, edit, etc.) — only the wrapping layer.
- Do NOT change SubagentTool or runAgent — they work correctly with native tools.
- The agent-loop in packages/agent already handles multiple tools natively.
- Test by running the agent and verifying it calls tools directly instead of writing JS code.
