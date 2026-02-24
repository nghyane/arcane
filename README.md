<p align="center">
  <img src="https://github.com/nghyane/arcane/blob/main/assets/hero.png?raw=true" alt="Arcane" width="720">
</p>

<h3 align="center">A coding agent that builds itself.</h3>
<p align="center"><em>Fork of <a href="https://github.com/anthropics/claude-code">Claude Code</a> by <a href="https://github.com/can1357">Can Boluk</a>, with a new Code Mode engine and rewritten TUI.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nghyane/arcane"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane?style=flat&colorA=222222&label=%40nghyane%2Farcane" alt="npm"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

---

Arcane is a terminal-native coding agent. Instead of calling tools one at a time, the LLM writes a JavaScript program that orchestrates reads, edits, and subagents — all in a single turn.

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

Code Mode replaces the core agent loop — instead of calling tools one at a time, the LLM writes a JavaScript program that orchestrates everything in a single turn. This is an architectural change too large for an upstream PR, so Arcane lives as its own project.

## What's new in Arcane

**Code Mode engine** — Each turn, the LLM writes a full async program: parallel reads, conditional edits, subagent fan-out. Work that takes 3-4 turns with sequential tool-calling finishes in one.

```javascript
async () => {
  const [app, utils] = await Promise.all([
    codemode.read({ path: "src/app.ts" }),
    codemode.read({ path: "src/utils.ts" }),
  ]);

  await codemode.edit({
    path: "src/app.ts",
    edits: [{ op: "set", tag: "3#XK", content: 'import { helper } from "./utils.js";' }],
  });

  return await codemode.lsp({ action: "diagnostics", files: ["src/app.ts"] });
}
```

**Rewritten TUI** — Differential rendering with surgical redraws, theming with bundled presets, Nerd Font detection, mouse text selection.

**Subagent architecture** — Task delegation with fan-out, todo-based completion tracking.

**Stats dashboard** — Local observability for token usage and tool call metrics.

## Inherited from upstream

**Hashline editing** — Edits anchor to content-derived hash tags, not line numbers. They survive concurrent modification, formatting, and reordering.

**Multi-provider LLM client** — 25+ providers through a single OAuth flow or API keys.

**TypeScript + Rust** — Bun for the runtime, Rust for performance-critical text and grep operations.

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
| [`@nghyane/arcane-codemode`](packages/codemode) | Code Mode engine — replaces tool-calling with JS orchestration |
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
