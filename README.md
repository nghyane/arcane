<p align="center">
  <img src="https://github.com/nghyane/arcane/blob/main/assets/hero.png?raw=true" alt="Arcane">
</p>

<p align="center">
  <strong>AI coding agent for the terminal</strong>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

---

## What is Arcane?

Arcane (`arc`) is an AI coding agent that runs in your terminal. It reads your codebase, edits files, runs commands, and manages git — all through natural language.

Multi-provider (Anthropic, OpenAI, Google, OpenRouter, Ollama, and more). Runs locally. No cloud IDE required.

## Highlights

- **Code Mode** — LLM writes JS to orchestrate tools in parallel (`Promise.all`) instead of sequential round-trips
- **Hashline Edits** — content-hash anchored edits that survive concurrent file changes
- **Multi-provider** — Claude, GPT, Gemini, Codex, local models via Ollama
- **Subagents** — dedicated reviewer (Gemini), oracle (GPT-5.3), explorer, librarian
- **Extensions** — themes, custom tools, slash commands, hooks, skills
- **Sessions** — persistent conversations with branching, compaction, and memory
- **TUI** — full terminal UI with syntax highlighting, diffs, and interactive components

## Installation

```bash
# Bun (recommended)
bun install -g @nghyane/arcane

# Or build from source
git clone https://github.com/nghyane/arcane.git
cd arcane
bun install
bun link --cwd packages/coding-agent
```

## Getting Started

```bash
# Start with any provider
arc                          # interactive mode
arc "fix the failing tests"  # one-shot mode
arc --model sonnet           # pick a model
arc --fast                   # use fast model for subagents
```

### API Keys

Set one or more provider keys:

```bash
export ANTHROPIC_API_KEY="..."   # Claude
export OPENAI_API_KEY="..."      # GPT / Codex
export GEMINI_API_KEY="..."      # Gemini
export OPENROUTER_API_KEY="..."  # OpenRouter (multi-provider)
```

Or use OAuth: `arc auth login`

### Terminal Setup

For best experience, use a terminal that supports:
- 24-bit color (truecolor)
- Unicode / emoji
- Mouse input (optional)

Recommended: iTerm2, Ghostty, WezTerm, Windows Terminal, Kitty.

## Usage

### Slash Commands

| Command | Description |
|---|---|
| `/model` | Switch model |
| `/think` | Set thinking level |
| `/compact` | Compress context |
| `/clear` | New session |
| `/branch` | Branch conversation |
| `/memory` | Manage memories |
| `/config` | Edit settings |
| `/help` | Show all commands |

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+J` | Submit message |
| `Escape` | Abort current operation |
| `Ctrl+L` | Clear screen |
| `Tab` | Accept autocomplete |
| `Up/Down` | Message history |

### Bash Mode

Prefix with `!` to run shell commands directly:

```
! git status
! bun test
```

### Image Support

Drag & drop images into the terminal, or paste image paths. The agent can analyze screenshots, diagrams, and UI mockups.

## Configuration

### Config Directory

`~/.arcane/agent/` — global config, sessions, memories, themes.

### Project Context

Place these files in your project root or `.arcane/` directory:

| File | Purpose |
|---|---|
| `AGENTS.md` | Project-specific instructions for the agent |
| `SYSTEM.md` | Custom system prompt (appended) |
| `models.yml` | Custom model/provider configuration |
| `settings.yml` | Agent settings |

### Custom Models

```yaml
# ~/.arcane/agent/models.yml
providers:
  my-ollama:
    baseUrl: http://localhost:11434/v1
    auth: none
    api: openai-completions
    discovery:
      type: ollama
```

## Extensions

Arcane supports extensions via TypeScript modules in `.arcane/extensions/` or `~/.arcane/agent/extensions/`.

- **Themes** — custom color schemes and icons
- **Slash Commands** — add project-specific commands
- **Tools** — register custom tools the agent can use
- **Hooks** — intercept session events (compaction, message, etc.)
- **Skills** — reusable prompt templates loaded on demand

See `docs://extensions` for the full API.

## CLI Reference

```
arc [message]              Start interactive or one-shot session
arc auth login             Authenticate with OAuth
arc auth status            Show auth status
arc doctor                 Run diagnostics
arc commit                 AI-powered commit messages
arc stats                  Usage dashboard
arc config                 Manage settings
```

| Flag | Description |
|---|---|
| `--model <pattern>` | Select model by name/pattern |
| `--fast <pattern>` | Override fast model for subagents |
| `--think <level>` | Set thinking level (min/low/medium/high/max) |
| `--system-prompt <text>` | Custom system prompt |
| `--continue` | Resume last session |
| `--print` | Non-interactive output mode |
| `--verbose` | Show debug information |

## Tools

The agent has access to:

| Tool | Description |
|---|---|
| `read` | Read files with line offsets |
| `edit` | Hashline-anchored file edits |
| `write` | Create/overwrite files |
| `bash` | Execute shell commands |
| `grep` | Regex search across files |
| `find` | Glob-based file discovery |
| `lsp` | Language server operations (diagnostics, definitions, references) |
| `fetch` | HTTP requests with content extraction |
| `web_search` | Multi-provider web search |
| `browser` | Puppeteer-based browser automation |
| `task` | Spawn subagent for parallel work |
| `code_review` | Dedicated code review (Gemini) |
| `oracle` | Cross-model reasoning advisor (GPT-5.3) |
| `explore` | Codebase exploration |
| `librarian` | Documentation/API lookup |

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, discoverAuthStorage, discoverModels } from "@nghyane/arcane";

const auth = await discoverAuthStorage();
const models = await discoverModels(auth);
const session = await createAgentSession({ auth, models });

for await (const event of session.sendMessage("Hello")) {
  // handle events
}
```

### RPC Mode

```bash
arc --rpc  # JSON-RPC over stdin/stdout
```

## Monorepo Packages

| Package | Description |
|---|---|
| `packages/coding-agent` | Main CLI application |
| `packages/agent` | Agent runtime with tool calling |
| `packages/ai` | Multi-provider LLM client |
| `packages/tui` | Terminal UI library |
| `packages/natives` | Rust bindings for text/grep ops |
| `packages/stats` | Usage dashboard |
| `packages/utils` | Shared utilities |
| `crates/arcane-natives` | Rust crate for performance-critical ops |

## Development

```bash
bun install
bun check     # TypeScript + Rust checks
bun fmt       # Format all
bun lint      # Lint all
```

## License

[GPL-3.0](LICENSE)

Original work copyright (c) [Can Boluk](https://github.com/can1357).
Modified work copyright (c) [Nghia Hoang](https://github.com/nghyane).
