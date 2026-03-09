# Changelog

## [Unreleased]

### Changed

- Split GitHub tool into `github` (issues/PRs/commits) and `github_fs` (file/tree browsing) with auto-detect owner/repo from git remote
- Restrict `github_fs` to subagents only (librarian); main agent delegates remote code reading via librarian

## [0.1.28] - 2026-03-08

### Fixed

- Fix edit tool: hashline delete missing `saveForUndo` causing unrecoverable file deletion
- Fix `any` types on `EditTool` class — replaced with `EditToolDetails`
- Fix `applyHashlineEdits` mutating caller's input array via splice

## [0.1.27] - 2026-03-08

### Fixed

- Fix GitHub tool: typed API interfaces replacing `any`, cache key collision with different media types, 403 rate limit not retried, `retry-after` NaN crash, raw file detection returning `[object Object]` for JSON files
- Fix bash timeout misreported as "Command aborted" instead of "Command timed out"
- Fix unhandled promise rejection crash in interactive bash PTY finalization
- Reorder HTML render pipeline to native-first, avoiding unnecessary network calls to jina.ai

### Changed

- Add GitHub tool guidance to system prompt
- Remove dead code: `normalizeBashCommand`, `expandSkillUrls`, `BashToolOptions`, `isInteractiveResult`

## [0.1.26] - 2026-03-08

### Fixed

- Improve session search by indexing all user messages instead of only the first
- Fix quoted phrase parsing in find_thread search queries
- Sort search results by relevance instead of date

### Removed

- Remove gemini-image and save-memory tools

### Changed

- Rename reviewer-tool.ts to reviewer.ts, subagent-tool.ts to subagent.ts
- RenderMermaid tool now displays diagram directly in TUI output

## [0.1.25] - 2026-03-08

### Added

- Propagate OAuth flag from auth storage to Anthropic client, replacing token-format heuristic

## [0.1.24] - 2026-03-08

### Changed

- Simplify hashline edit API to two operations: replace and insert
- Remove redundant comments from patch module

## [0.1.23] - 2026-03-08

### Fixed

- Fix Python setup installing packages into system Python instead of managed venv, causing "kernel unavailable" even after install
- Fix missing `ensurepip` step when managed venv lacks pip
- Fix misleading error message to point users to `arcane setup python`

## [0.1.22] - 2026-03-08

### Changed

- Rename edit operation `replace` to `replace_range` for clarity

## [0.1.21] - 2026-03-05

### Fixed

- Fix crash when extension tools define renderCall/renderResult (readonly property assignment)

## [0.1.20] - 2026-03-05

### Added

- Spinner animation on tool calls while running

### Changed

- Stricter tool schemas and simplified edit tool insert operation
- Improved edit error steering and diff preview
- Normalize node:path/fs imports to namespace style

### Fixed

- Task tool returns plain text instead of JSON-serialized result
- GitHub client non-JSON response handling
- Tab sanitization in hashline

### Performance

- Reuse markdown components and throttle stream renders

## [0.1.17] - 2026-03-02

### Added

- Thread search and retrieval tools (find-thread, read-thread)
- Save-memory tool for cross-session fact storage
- Mermaid diagram rendering tool (render-mermaid)
- Kagi web search provider
- Codex OAuth authentication support
- AST auto-inclusion in subagent context
- Ask tool abort support

### Changed

- Improved Gemini provider retry logic
- Enhanced hashline tab handling

### Removed

- Memory system (replaced by thread/save-memory tools)

## [0.1.14] - 2026-03-02

### Removed

- `arc commit` command and entire commit pipeline (agentic commit, map-reduce, changelog generation)
- `quick_task` bundled agent (only used by commit flow)
- `commit.*` settings (`mapReduceEnabled`, `mapReduceMinFiles`, `mapReduceMaxFileTokens`, `mapReduceTimeoutMs`, `mapReduceMaxConcurrency`, `changelogMaxDiffChars`)
- Codemode execution layer — LLM now calls tools natively instead of writing JavaScript ([#49](https://github.com/nghyane/arcane/issues/49))
- `code-tool.ts`, `executor.ts`, `normalize.ts`, `prompt.ts`, and all codemode prompt snippets
- `CodeGroupComponent` TUI component (step/progress rendering for code tool)

### Added

- Context tool grouping: consecutive read/grep/find/fetch/search_code/lsp/notebook calls are batched into a collapsible summary line (Ctrl+O to expand) ([#51](https://github.com/nghyane/arcane/issues/51))
- Left-border accent style for action/subagent tool output, replacing full-background boxes ([#51](https://github.com/nghyane/arcane/issues/51))
- `LeftBorderBox` TUI component for rendering content with a colored left border
- `ContextGroupComponent` for batching context-gathering tools
- `isContextTool()` utility in render-utils
- `setMarginTop()` on `ToolExecutionComponent` for sibling-aware spacing

### Changed

- Tools are now returned directly from `createTools()` as individual `AgentTool` instances
- System prompt updated for native tool calling guidance
- Tool output styling changed from background color to left-border color indicating status (accent=pending, green=success, red=error)
- Smart spacing: removed no-op `Text("", 0, 0)` spacers between tools; block tools use internal `Spacer(1)`, context groups render compactly
- Session rebuild (`renderSessionContext`) now groups context tools consistently with streaming path

## [0.1.12] - 2026-02-24

### Fixed

- Preserve single blank line content in edit tool — `hashlineParseContent` no longer strips the only line when it is empty

### Changed

- Stream codemode intent immediately during LLM generation instead of waiting for execution start
- Hide loader spinner when codemode group is active to avoid duplicate status indicators

## [0.1.8] - 2026-02-22

### Changed

- Read VERSION from own package.json instead of shared utils package
