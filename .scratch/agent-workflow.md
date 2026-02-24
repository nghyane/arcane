# Agent Workflow — Prompt Architecture

## 1. Session Boot

```
User launches arc
        │
        ▼
buildSystemPrompt()                              ← system-prompt.ts
  │
  ├── [Parallel Resolve — 5s timeout]
  │   ├── SYSTEM.md scan (user + project)        → systemPromptCustomization
  │   ├── Context files (.arcane/*.md)            → contextFiles[]
  │   ├── AGENTS.md scan (depth 1-4, max 200)    → agentsMdSearch
  │   ├── Skills (~/.arcane/skills/)              → skills[]
  │   ├── Preloaded skill contents                → preloadedSkills[]
  │   ├── Git context (branch, status, 5 logs)   → git
  │   └── Environment (OS, CPU, GPU, terminal)    → environment
  │
  ├── createTools(session)
  │   ├── Instantiate: Read, Bash, Grep, Find, Edit, Write, LSP,
  │   │   GitHub, Browser, Fetch, WebSearch, SSH, Task, Oracle,
  │   │   Librarian, Explorer, Reviewer, Python, Calculator, ...
  │   │
  │   └── createCodeTool(tools)                   ← packages/codemode/
  │       ├── Exclude: [ask] (interactive)
  │       ├── generateTypes(wrappedTools)
  │       │   ├── TypeBox schema → TS interface per tool
  │       │   ├── tool.description → extractToolSummary() → JSDoc
  │       │   └── Output: `declare const codemode: { ... }`
  │       └── prompt.md + {{types}} → code tool description
  │
  └── Render system-prompt.md via Handlebars
      └── Output: complete system prompt string
```

## 2. System Prompt Structure

```
┌─────────────────────────────────────────────────────────────┐
│ <identity>                                                  │
│   Staff engineer persona. Correctness > politeness.         │
│   Initiative rules: do vs approach vs explain.              │
│                                                     16 lines│
├─────────────────────────────────────────────────────────────┤
│ <discipline>                                                │
│   Anti-patterns: completion reflex, "it works" bias.        │
│   Pre-code checklist: assumptions, breaks, simplicity.      │
│                                                     16 lines│
├─────────────────────────────────────────────────────────────┤
│ <context>                         [conditional: SYSTEM.md]  │
│   User/project system prompt customization.                 │
│                                                    variable │
├─────────────────────────────────────────────────────────────┤
│ <environment>                                               │
│   OS, arch, CPU, terminal info.                             │
│                                                     ~5 lines│
├─────────────────────────────────────────────────────────────┤
│ <tools>                                                     │
│   Tool name list: - read  - bash  - code  ...               │
│   Tool Guidance:                                            │
│     Precedence: specialized > bash                          │
│     Search before read                                      │
│     LSP > grep for semantic queries                         │
│     SSH: match remote shell                                 │
│                                                      8 lines│
├─────────────────────────────────────────────────────────────┤
│ <conventions>                                               │
│   Code Conventions:                                         │
│     Style mimicry, no assumed deps, no error suppression,   │
│     no secrets, no background processes, test framework check│
│   Communication:                                            │
│     No internal tool names, no flattery, no thanks,         │
│     GFM format, explain destructive ops, never ask to cont. │
│   Git Hygiene:                                              │
│     Dirty worktree awareness, no amend, no reset --hard     │
│                                                     26 lines│
├─────────────────────────────────────────────────────────────┤
│ <procedure>                                                 │
│   Task Execution: assess → do → if blocked: explore → ask   │
│   Task Tracking: todos for multi-step, skip for trivial     │
│   Delegation:                    [conditional: task tool]    │
│     Oracle (plan) → Explore (scope) → Task (execute)        │
│     When to use Task: 4+ independent files, parallel streams│
│   Verification: external proof, test first, formatter last  │
│   Mandatory Diagnostics: fix own errors, note pre-existing  │
│   Concurrency: re-read if edits fail, ask before destructive│
│   Integration: AGENTS.md = local law                        │
│                                                     ~65 lines│
├─────────────────────────────────────────────────────────────┤
│ <project>                                                   │
│   Context files (AGENTS.md contents)                        │
│   Git: branch, status, recent 5 commits                     │
│                                                    variable │
├─────────────────────────────────────────────────────────────┤
│ <harness>                                                   │
│   docs:// internal URLs for arc documentation               │
│                                                      5 lines│
├─────────────────────────────────────────────────────────────┤
│ <skills>                         [conditional: skills exist] │
│   Skill name + description list. Read skill:// if matches.  │
│                                                    variable │
├─────────────────────────────────────────────────────────────┤
│ <rules>                           [conditional: rules exist] │
│   Rule name + description + globs. Read rule:// if matches. │
│                                                    variable │
├─────────────────────────────────────────────────────────────┤
│ <parallel_reflex>                [conditional: task tool]    │
│   "When work forks, you fork."                              │
│                                                      2 lines│
├─────────────────────────────────────────────────────────────┤
│ <output_style>                                              │
│   No filler, no emojis, no ceremony. Suppress specific words│
│                                                      4 lines│
├─────────────────────────────────────────────────────────────┤
│ <contract>                                                  │
│   7 inviolable rules:                                       │
│   1. Never claim unverified correctness                     │
│   2. Never yield incomplete                                 │
│   3. Never suppress tests / fabricate outputs               │
│   4. Never avoid necessary breaking changes                 │
│   5. Never solve wrong problem                              │
│   6. Never ask for obtainable info                          │
│   7. Full cutover — no shims                                │
│                                                      9 lines│
├─────────────────────────────────────────────────────────────┤
│ <diligence>                                                 │
│   "GET THE TASK DONE." Persist. Edge cases. Defend code.    │
│                                                     14 lines│
├─────────────────────────────────────────────────────────────┤
│ <stakes>                                                    │
│   High-reliability industry framing.                        │
│                                                      6 lines│
├─────────────────────────────────────────────────────────────┤
│ <critical>                                                  │
│   Every turn must advance. Default to action.               │
│   Verify changes. Run diagnostics.                          │
│                                                      6 lines│
└─────────────────────────────────────────────────────────────┘
```

## 3. Code Tool — What Agent Sees

```
Tool: "code"
Description:
┌─────────────────────────────────────────────────────────────┐
│ Execute JavaScript code to accomplish tasks. Instead of     │
│ calling tools individually, write an async arrow function   │
│ that orchestrates multiple operations.                      │
│                                                             │
│ ## Available API                                            │
│                                                             │
│ interface GithubInput {                                     │
│   action: "get_repo" | "get_file" | "get_tree" | ...;      │
│   owner: string;                                            │
│   repo: string;                                             │
│   path?: string;                                            │
│   limit?: number;   // Max results (default 100, max 500)   │
│   ...                                                       │
│ }                                                           │
│ interface ReadInput { path: string; offset?: number; ... }  │
│ interface BashInput { command: string; timeout?: number; ... }│
│ interface GrepInput { pattern: string; path?: string; ... } │
│ ... (all tool interfaces)                                   │
│                                                             │
│ declare const codemode: {                                   │
│   /** Access GitHub repos, issues, PRs, code search... */   │
│   github: (input: GithubInput) => Promise<unknown>;         │
│   /** Reads files from local filesystem or internal URLs */ │
│   read: (input: ReadInput) => Promise<unknown>;             │
│   /** Executes bash command in shell session... */          │
│   bash: (input: BashInput) => Promise<unknown>;             │
│   /** Powerful search tool built on ripgrep. */             │
│   grep: (input: GrepInput) => Promise<unknown>;             │
│   ... (all tools)                                           │
│ };                                                          │
│                                                             │
│ declare const state: Map<string, unknown>;                  │
│ declare const memo: <T>(key, fn) => Promise<T>;             │
│                                                             │
│ ## Rules                                                    │
│ - async () => { ... }                                       │
│ - await all codemode.* calls                                │
│ - Default to Promise.all()                                  │
│ - No console.log — results stream to UI                     │
│ - Return final result                                       │
│                                                             │
│ ## Persistent State                                         │
│ state Map + memo helper across executions                   │
│                                                             │
│ ## Examples                                                 │
│ (parallel reads → parallel edits → verify)                  │
└─────────────────────────────────────────────────────────────┘
```

## 4. Runtime Execution

```
User message
    │
    ▼
LLM receives: system prompt + conversation history + tool definitions
    │
    ▼
LLM decides action, writes code:
    async () => {
      const issues = await codemode.github({ action: "list_issues", ... });
      const file = await codemode.read({ path: "src/app.ts" });
      await codemode.edit({ path: "src/app.ts", edits: [...] });
      return await codemode.bash({ command: "bun check" });
    }
    │
    ▼
code tool.execute(code)
    │
    ├── normalizeCode()          strip markdown fences, validate
    │
    ├── buildDispatchFns()       for each wrapped tool:
    │   │                        safeName → async (toolCallId, args) => {
    │   │                          result = await tool.execute(...)
    │   │                          emit tool_execution_update → TUI
    │   │                          return textContent || details
    │   │                        }
    │   │
    │   └── codemode = Proxy     property access → dispatch lookup
    │
    ├── execute(code, fns, { state, timeoutMs })
    │   │
    │   │   Sandbox (same process, NOT secure):
    │   │   - process, require, Bun, globalThis → shadowed
    │   │   - console → captured to logs[]
    │   │
    │   └── new AsyncFunction(code)(codemode, state, memo)
    │       │
    │       ├── codemode.github({...})
    │       │   └── dispatch → GitHubTool.execute()
    │       │       └── handleAction() → { text, url }
    │       │       └── toolResult(details).text().done()
    │       │       └── emit update → TUI renders live
    │       │       └── return text string to code
    │       │
    │       ├── codemode.read({...})  → same flow
    │       ├── codemode.edit({...})  → same flow
    │       └── codemode.bash({...})  → same flow
    │
    └── Return: { result, logs, error? }
        │
        ▼
    AgentToolResult sent back to LLM
    LLM sees return value (truncated to 4000 chars)
    │
    ▼
LLM generates response text + optionally more code calls
```

## 5. Subagent Flow (Task / Oracle / Librarian / Explorer / Reviewer)

```
Main agent decides to delegate
    │
    ▼
codemode.task({ id, description, assignment, context?, skills? })
    │
    ▼
TaskTool.execute()
    │
    ├── Build subagent system prompt:
    │   subagent-system-prompt.md template:
    │   ┌─────────────────────────────────────┐
    │   │ {{base}}                            │  ← full main system prompt
    │   │ ====================================│     (identity, discipline,
    │   │ {{agent}}                           │      conventions, procedure,
    │   │                                     │      project context, etc.)
    │   │ <context>                           │
    │   │ Check {{contextFile}} for parent    │  ← conversation file path
    │   │ conversation context.               │
    │   │ </context>                          │
    │   │                                     │
    │   │ <critical>                          │
    │   │ - When done, stop. Final text =     │
    │   │   your output to parent.            │
    │   │ - Don't abort; use tools first.     │
    │   │ </critical>                         │
    │   └─────────────────────────────────────┘
    │
    ├── Build subagent user prompt:
    │   subagent-user-prompt.md template:
    │   ┌─────────────────────────────────────┐
    │   │ <swarm_context>{{context}}</...>    │  ← shared context from parent
    │   │                                     │
    │   │ # Your Assignment                   │
    │   │ {{assignment}}                      │  ← specific task instructions
    │   └─────────────────────────────────────┘
    │
    ├── Spawn independent LLM session
    │   - Full tool access (own createTools)
    │   - No conversation history from parent
    │   - CAN grep parent's conversation file
    │
    └── Return result text to parent agent
```

## 6. Compaction (Context Window Management)

```
Conversation grows → approaching context limit
    │
    ▼
Compaction triggered
    │
    ├── compaction-summary.md:
    │   "Summarize conversation into structured checkpoint"
    │   Format: Goal → Constraints → Progress (Done/InProgress/Blocked)
    │          → Key Decisions → Next Steps → Critical Context
    │
    ├── Output: structured summary
    │
    └── compaction-summary-context.md:
        "Another language model started to solve this problem
         and produced a summary. Use this to build on work
         already done and avoid duplicating work."
        │
        └── Injected as context for continued session
```

## 7. Auxiliary Prompts

```
title-system.md          "Generate 3-6 word title for session"
                          → Tab title in TUI

summarization-system.md  "Read conversation, produce structured summary"
                          → Session export / review

ttsr-interrupt.md        "<system_interrupt reason=rule_violation>"
                          → Enforces user-defined rules mid-generation
                          → Interrupts output, forces compliance

custom-system-prompt.md  Alternative system prompt template
                          → Used when --system-prompt flag provided
                          → Replaces standard system-prompt.md
                          → Still gets: context files, git, skills, rules
```

## 8. Data Flow Summary

```
                    ┌──────────────────┐
                    │   system-prompt  │
                    │   .md            │
                    │                  │
                    │  <identity>      │
                    │  <discipline>    │
                    │  <tools>         │ ─── tool routing
                    │  <conventions>   │
                    │  <procedure>     │
                    │  <project>       │ ─── AGENTS.md, git
                    │  <contract>      │
                    │  <diligence>     │
                    │  <stakes>        │
                    │  <critical>      │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  "code"  │  │  "ask"   │  │ subagent │
        │  tool    │  │  tool    │  │ sessions │
        └────┬─────┘  └──────────┘  └────┬─────┘
             │                            │
     ┌───────┴───────┐            subagent-system
     │               │            -prompt.md
  prompt.md    TS declarations      │
  (execution   (API + JSDoc)     {{base}} = full
   mechanics)                    system prompt
     │               │              │
     └───────┬───────┘           agent prompt
             │                   (task.md /
             ▼                    oracle.md / ...)
     Agent writes JS code            │
     using codemode.*            assignment
             │                   from parent
             ▼
     Proxy dispatch → tool.execute()
             │
             ▼
     Result text → back to LLM
```

## 9. What Agent ACTUALLY Sees (Token Budget)

```
System prompt (~200 lines)
  ├── Fixed overhead: identity, discipline, conventions,
  │   procedure, contract, diligence, stakes, critical
  │   → ~150 lines, stable across sessions
  │
  ├── Variable: AGENTS.md, git context, skills, rules
  │   → depends on project, can be large
  │
  └── Tool list: ~5 lines (just names)

Code tool description (~50 lines + TS declarations)
  ├── prompt.md rules: ~20 lines
  ├── TS interfaces: ~10-30 lines per complex tool
  │   (GithubInput, BashInput, EditInput, etc.)
  ├── JSDoc: 1 line per tool (first paragraph summary)
  └── state/memo declarations: 3 lines

  Total TS declarations: ~200-400 lines depending on
  enabled tools

Ask tool description: ~10 lines (separate, not in codemode)

Tool .md files: INVISIBLE to agent
  └── Only first paragraph survives as JSDoc
  └── Rest is developer documentation only
```


## 10. Codemode Fitness Audit

### Rating Scale
- **OK** — Works correctly in codemode context
- **STALE** — References non-codemode concepts, causes confusion
- **NOISE** — Redundant or contradictory information
- **DEAD** — Never reaches agent

### System Prompt Sections

| Section | Rating | Issue |
|---|---|---|
| `<identity>` | **OK** | Generic persona, no tool references |
| `<discipline>` | **OK** | Code thinking checklist, tool-agnostic |
| `<environment>` | **OK** | OS/CPU info, no tool dependency |
| `<tools>` list | **STALE** | Renders `- code\n- ask` — agent sees only these 2 tool names. But Tool Guidance references `read`, `grep`, `find`, `edit`, `lsp`, `bash` as if they're standalone tools. Agent has to infer these are `codemode.read()`, `codemode.grep()` etc. |
| `<tools>` guidance | **STALE** | "Never shell out for operations the API covers — `read` not `cat`" — framing assumes standalone tools. Should reference `codemode.read()` vs `codemode.bash({ command: 'cat' })` or drop tool name specifics entirely since agent reads the TS API. |
| `<conventions>` Code | **OK** | About user's code, not agent's tool usage |
| `<conventions>` Communication | **STALE** | "Never refer to tools by their internal names" — but agent only HAS `code` and `ask`. The "internal names" (`read`, `grep`) are API methods on `codemode.*`, not tool names. Rule is confusing. |
| `<conventions>` Git | **OK** | Git workflow, no tool dependency |
| `<procedure>` Task Execution | **OK** | Generic workflow |
| `<procedure>` Delegation | **OK** | References Oracle/Explore/Task — these exist as `codemode.oracle()` etc. Agent understands. |
| `<procedure>` Verification | **OK** | Generic |
| `<procedure>` Mandatory Diagnostics | **OK** | Generic |
| `<procedure>` Concurrency | **OK** | Generic |
| `<project>` | **OK** | AGENTS.md, git context — no tool refs |
| `<harness>` | **OK** | docs:// URLs resolved by `codemode.read()` |
| `<skills>` | **OK** | Skill descriptions, skill:// protocol |
| `<rules>` | **OK** | Rule descriptions |
| `<parallel_reflex>` | **OK** | "When work forks, you fork" — references Task tool, works |
| `<output_style>` | **OK** | Communication style, no tool refs |
| `<contract>` | **OK** | Behavioral rules, tool-agnostic |
| `<diligence>` | **OK** | Motivation, tool-agnostic |
| `<stakes>` | **OK** | Framing, tool-agnostic |
| `<critical>` | **OK** | Action rules, tool-agnostic |

### Code Tool (prompt.md)

| Aspect | Rating | Issue |
|---|---|---|
| Execution rules | **OK** | Clean, codemode-native |
| TS declarations | **OK** | Generated from live schemas |
| JSDoc summaries | **OK** | Fixed — now extracts first paragraph |
| Examples | **OK** | Shows codemode.* usage pattern |
| Persistent state docs | **OK** | state + memo documented |

### Tool .md Files

| Aspect | Rating | Issue |
|---|---|---|
| First paragraph | **OK** | Becomes JSDoc — agent sees it |
| "When to use" | **DEAD** | Never reaches agent |
| "When NOT to use" | **DEAD** | Never reaches agent |
| Parameter docs | **DEAD** | Redundant with TS interface |
| Conditions | **DEAD** | Never reaches agent |
| Instructions | **DEAD** | Never reaches agent |

### Summary of Issues to Fix

1. **`<tools>` section** — Tool list shows `code` and `ask`, but Tool Guidance references `read`, `grep`, `find`, `edit`, `lsp`, `bash` as standalone tools
   - **Fix**: Reframe guidance to reference `codemode.*` API methods, or make it concept-level ("use specialized file reading over shell commands")
   
2. **Communication rule** — "Never refer to tools by their internal names" is stale
   - **Fix**: Remove or reframe. Agent's visible tools are `code` and `ask`. Sub-tool names are API methods, not "internal names".

3. **Tool .md files** — 80%+ of content is dead code
   - **Fix**: Optional cleanup. No runtime impact but maintenance debt. Developers may waste time writing detailed prompts that never reach agent.
