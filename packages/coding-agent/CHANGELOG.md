# Changelog

## [Unreleased]

### Removed

- `arc commit` command and entire commit pipeline (agentic commit, map-reduce, changelog generation)
- `quick_task` bundled agent (only used by commit flow)
- `commit.*` settings (`mapReduceEnabled`, `mapReduceMinFiles`, `mapReduceMaxFileTokens`, `mapReduceTimeoutMs`, `mapReduceMaxConcurrency`, `changelogMaxDiffChars`)
- Codemode execution layer — LLM now calls tools natively instead of writing JavaScript ([#49](https://github.com/nghyane/arcane/issues/49))
- `code-tool.ts`, `executor.ts`, `normalize.ts`, `prompt.ts`, and all codemode prompt snippets
- `CodeGroupComponent` TUI component (step/progress rendering for code tool)

### Changed

- Tools are now returned directly from `createTools()` as individual `AgentTool` instances
- System prompt updated for native tool calling guidance

## [0.1.12] - 2026-02-24

### Fixed

- Preserve single blank line content in edit tool — `hashlineParseContent` no longer strips the only line when it is empty

### Changed

- Stream codemode intent immediately during LLM generation instead of waiting for execution start
- Hide loader spinner when codemode group is active to avoid duplicate status indicators

## [0.1.8] - 2026-02-22

### Changed

- Read VERSION from own package.json instead of shared utils package
