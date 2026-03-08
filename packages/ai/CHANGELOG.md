# Changelog

## [Unreleased]

### Added

- `isOAuth` option in `StreamOptions` and `AnthropicClientOptionsArgs` to explicitly signal OAuth authentication

### Changed

- Update stealth Claude Code version to 2.1.71 and Stainless package version to 0.78.0

## [0.1.13] - 2026-03-08

### Fixed

- Add `discriminator` to unsupported schema fields for Google providers
- Enable discriminator support in AJV validation
- Fix Codex provider arguments type to accept any value

## [0.1.12] - 2026-03-05

### Fixed

- OpenAI-compatible provider model handling

## [0.1.10] - 2026-03-02

### Added

- Rate limit retry utilities for provider resilience
- Enhanced response validation

### Fixed

- Anthropic provider error handling
- Gemini CLI provider configuration
