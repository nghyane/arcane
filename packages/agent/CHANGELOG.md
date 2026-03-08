# Changelog

## [Unreleased]

### Added

- `ResolvedApiKey` type for `getApiKey` to return both key and OAuth flag

### Changed

- `getApiKey` now accepts `ResolvedApiKey | string | undefined` return type

## [0.1.12] - 2026-03-02

### Removed

- `execution_abort`, `step_start`, `step_end`, `step_progress` event types from `AgentEvent` union
