<p align="center">
  <img src="https://github.com/nghyane/arcane/blob/main/assets/hero.png?raw=true" alt="Arcane" width="720">
</p>

<h3 align="center">A coding agent that builds itself.</h3>
<p align="center"><em>Fork of <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> by <a href="https://github.com/can1357">Can Boluk</a>, with a rewritten TUI and redesigned subagent system.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nghyane/arcane"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane?style=flat&colorA=222222&label=%40nghyane%2Farcane" alt="npm"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

---

Arcane is a terminal-native coding agent built on Bun and Rust. It extends the upstream oh-my-pi fork with a rewritten terminal UI, a redesigned subagent system, and streamlined prompt architecture.

> **Note**: Documentation is a work in progress.

## Quickstart

```bash
bun install -g @nghyane/arcane
arc auth login                   # OAuth — one flow for all providers
arc                              # interactive mode
arc "fix the failing tests"      # one-shot
```

<details>
<summary><strong>Build from source</strong></summary>

```bash
git clone https://github.com/nghyane/arcane.git
cd arcane && bun install
bun link --cwd packages/coding-agent
```

</details>

## Why fork?

Arcane diverges from upstream in three areas that are too invasive for PRs: a ground-up TUI rewrite with differential rendering, a redesigned subagent/task system with structured delegation, and a simplified prompt architecture that co-locates tool definitions with their guidance. Together these touch nearly every layer of the stack, so Arcane lives as its own project.

## Design philosophy

Arcane is a **lightweight coding agent**, not a general-purpose AI platform.

- **Fixed tool set** — Five bundled subagents (explore, librarian, oracle, reviewer, task) cover the coding workflow. No plugin marketplace, no custom agent definitions.
- **Depth over breadth** — Every feature serves code editing, search, or review. Features that don't earn their keep get cut.
- **Single source of truth** — Tool definitions, schemas, and prompt guidance live together. No runtime overrides or dual config.
- **Task complexity routing** — `low` and `high` complexity levels route subagent work to the right model automatically.

## What's new in Arcane

**Rewritten TUI** — Differential rendering with double buffering, LeftBorderBox layout, bundled theme presets (Nord Frost), Nerd Font detection, mouse text selection, transparent status line, and declarative tool renderers.

**Redesigned subagent system** — Five specialized subagents with structured delegation: explore (local code search), librarian (cross-repo search), oracle (planning and review), reviewer (code review), and task (fire-and-forget execution with todo tracking).

**Streamlined prompt architecture** — Tool descriptions co-located with definitions, agent prompts in static Markdown with Handlebars, no runtime prompt generation. Removed intent tracing, commit pipeline, and custom agent discovery.

**Declarative tool rendering** — Tool renderers declared alongside tool definitions. No renderer registry, no runtime dispatch.

## Inherited from upstream

Arcane is built on top of [oh-my-pi](https://github.com/can1357/oh-my-pi) by Can Boluk, which itself forks [pi-mono](https://github.com/badlogic/pi-mono). The following are upstream features:

**Hashline editing** — Edits anchor to content-derived hash tags, not line numbers. They survive concurrent modification, formatting, and reordering.

**Multi-provider LLM client** — 25+ providers through a single OAuth flow or API keys.

**Extension system** — Themes, skills, hooks, and custom tools.

**Sessions** — Branching, context compaction, and autonomous memory.

**TypeScript + Rust** — Bun for the runtime, Rust for performance-critical text and grep operations.

**Stats dashboard** — Local observability for token usage and tool call metrics.

## Providers

Arcane supports 25+ LLM providers through a single OAuth flow or API keys.

```bash
arc auth login                          # OAuth — recommended
export ANTHROPIC_API_KEY="..."          # or set keys directly
export OPENAI_API_KEY="..."
export GEMINI_API_KEY="..."
export OPENROUTER_API_KEY="..."
```

Anthropic, OpenAI, Google, Copilot, OpenRouter, Ollama, and any OpenAI-compatible endpoint.

<details>
<summary><strong>Custom provider</strong></summary>

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

</details>

## Architecture

| Package | Description |
|---|---|
| [`@nghyane/arcane`](packages/coding-agent) | Main CLI application |
| [`@nghyane/arcane-agent`](packages/agent) | Agent runtime with tool calling |
| [`@nghyane/arcane-ai`](packages/ai) | Multi-provider LLM client |
| [`@nghyane/arcane-tui`](packages/tui) | Terminal UI library |
| [`@nghyane/arcane-natives`](packages/natives) | Rust bindings for text/grep ops |
| [`@nghyane/arcane-stats`](packages/stats) | Usage dashboard |
| [`@nghyane/arcane-utils`](packages/utils) | Shared utilities |

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
