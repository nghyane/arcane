# TUI Refactor — Implementation Prompt

Spec: https://github.com/nghyane/arcane/issues/50
Read the full issue first — it has mockups for every tool/state, tier assignments, expand rules, and spacing rules.

You are refactoring the coding-agent's tool TUI renderers to a consistent tree-style design.

## Core Rules

- **No bordered cards** — remove `CachedOutputBlock`, `renderOutputBlock`, `renderCodeCell`, `DynamicBorder`
- **No background colors** — remove `#getBgFn()`, `getStateBgColor()`, `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` from theme, `Box` with bgFn
- **Tree chars** (`├─`/`└─`/`│`) for all structured output. Plain indent for prose.
- **No-flicker** — content only grows (append), header updates in-place
- **Header format**: `icon Title: description · meta1 · meta2` (use existing `renderStatusLine`)

## Tier System

Add `TOOL_TIERS` map to classify every tool. Tiers control color, spacing, and expand behavior:

| Tier | Color | Spacing | Expand |
|------|-------|---------|--------|
| quiet | dim | no blank line between consecutive quiet tools | none |
| action | normal | 1 blank line before | per-tool (see issue) |
| interactive | normal | 1 blank line before | none |
| subagent | normal | 1 blank line before | task: last 3 tools |
| default (MCP) | normal | 1 blank line before | JSON tree Ctrl+O |

**Quiet**: read, grep, find, fetch, search_code, lsp, browser, github, notebook, undo_edit, generate_image
**Action**: bash, ssh, python, edit, write, web_search, exa tools
**Interactive**: ask, todo_write
**Subagent**: task, explore, librarian, oracle, code_review

## Migration Order

Work incrementally, one step at a time. Verify `bun check` passes after each step.

### Step 1: Tier infrastructure
- Add `TOOL_TIERS` map + `getToolTier()` lookup in `ui/render-utils.ts`
- Update `event-controller.ts`: tier-aware spacing (no blank line between quiet, 1 blank line before action/subagent)
- Remove `ReadToolGroupComponent` and read-grouping logic from `event-controller.ts` (`#lastReadGroup`, `#resetReadGroup`, `#getReadGroup`, the `content.name === "read"` branch)

### Step 2: Remove backgrounds
- Remove `#getBgFn()` from `tool-execution.ts`
- Remove `Box` with bgFn — replace with plain container
- Remove `getStateBgColor()` from `tui/utils.ts`
- Remove `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` from theme
- Remove `inline` flag from bash, python, lsp tool definitions and `AgentTool` interface

### Step 3: Quiet tools
- Each quiet tool `renderResult` returns a single status line string (dim). No tree list, no expand hint.
- Remove `formatExpandHint` usage from: grep, find, lsp, fetch, search_code, browser, github, notebook, undo_edit
- Remove `renderTreeList` usage from grep/find renderResult (counts go in header meta only)

### Step 4: bash/ssh/python
- Rewrite `BashExecutionComponent` and `PythonExecutionComponent` to tree-style output
- Agent-initiated bash/python (`renderResult` in tool files): tree-style with tail 4 lines (success), all lines (error), Ctrl+O expand
- Remove `DynamicBorder` (`dynamic-border.ts`)
- Remove `visual-truncate.ts`
- Remove `CachedOutputBlock` usage from bash, ssh

### Step 5: edit/write
- Edit: tree-style diff with hunk headers, cap 8 hunks, Ctrl+O. Streaming realtime diff preview.
- Write: tree-style content tail 6 lines, Ctrl+O. Streaming tail preview.

### Step 6: web_search/exa
- Create shared search sources renderer: show `title (domain)` per source, cap 5, Ctrl+O for all
- Wire `web_search` renderResult to use it
- Wire all exa tools to use it (remove or simplify `exa/render.ts`)

### Step 7: Subagents
- Task: tool history only, no conclusion text. Collapsed: last 3 tools, Ctrl+O for all.
- explore/librarian/oracle/code_review: tool history + markdown conclusion (indented, no `│` prefix)
- Add markdown renderer for conclusion blocks

### Step 8: MCP/extension default renderer
- Rewrite `default-renderer.ts`: JSON tree with collapsed/expanded, Ctrl+O expand, normal color

### Step 9: Dead code cleanup
- Delete: `tui/output-block.ts`, `tui/code-cell.ts`, `modes/components/read-tool-group.ts`, `modes/components/dynamic-border.ts`, `modes/components/visual-truncate.ts`
- Remove all unused imports across touched files
- Run `bun check` to verify

## Key Files

All paths relative to `packages/coding-agent/src/`:

- `modes/components/tool-execution.ts` — main orchestrator
- `modes/controllers/event-controller.ts` — creates components, spacing
- `tools/default-renderer.ts` — fallback renderer
- `tui/status-line.ts` — KEEP, already matches target header
- `tui/tree-list.ts` — KEEP
- `tui/output-block.ts` — DELETE
- `tui/code-cell.ts` — DELETE
- `ui/render-utils.ts` — add tier constants
- `modes/components/read-tool-group.ts` — DELETE
- `modes/components/bash-execution.ts` — REWRITE
- `modes/components/python-execution.ts` — REWRITE
- `modes/components/dynamic-border.ts` — DELETE
- `modes/components/visual-truncate.ts` — DELETE
- `web/search/render.ts` — shared sources renderer
- `exa/render.ts` — DELETE or delegate
- `patch/shared.ts` — edit renderer
- `task/render.ts` — subagent/task renderer
- `tools/*.ts` — individual tool renderers

## Validation

After each step: `bun fmt && bun check`. Fix all errors before moving to next step.
