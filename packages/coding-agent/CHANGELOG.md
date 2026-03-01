# Changelog

## [Unreleased]

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
