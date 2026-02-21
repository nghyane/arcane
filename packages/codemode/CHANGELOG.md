# Changelog

## [Unreleased]

### Added

- Initial release of Code Mode package
- `createCodeTool()` wraps tool registry into a single LLM-callable "code" tool
- TypeScript type generation from tool schemas for typed LLM orchestration
- JSON Schema to TypeScript converter
- Code normalizer for LLM-generated JavaScript
- Sandboxed executor with timeout and abort support
- Event bridge for transparent sub-tool TUI rendering

### Fixed

- Exclude `task` tool from Code Mode wrapping — task is an orchestration tool that requires `onUpdate` for progress streaming and has its own subprocess lifecycle incompatible with codemode's sandbox
- Increase result truncation threshold from 500 to 4000 chars and show truncation notice instead of silently dropping large results
