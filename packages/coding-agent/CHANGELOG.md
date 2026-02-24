# Changelog

## [Unreleased]

### Fixed

- Preserve single blank line content in edit tool — `hashlineParseContent` no longer strips the only line when it is empty

### Changed

- Stream codemode intent immediately during LLM generation instead of waiting for execution start
- Hide loader spinner when codemode group is active to avoid duplicate status indicators

## [0.1.8] - 2026-02-22

### Changed

- Read VERSION from own package.json instead of shared utils package
