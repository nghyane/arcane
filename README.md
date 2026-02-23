
<p align="center">

https://github.com/user-attachments/assets/c28fb0c5-b3e4-430d-b5a1-26b855beaa28
</p>

<h3 align="center">An AI that codes its own tools.</h3>

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

## What makes it different

**Code as tool call** — Each turn, the LLM writes a full async program: parallel reads, conditional edits, subagent fan-out. No sequential round-trips.

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

**Hashline editing** — Edits anchor to content-derived hash tags, not line numbers. They survive concurrent modification, formatting, and reordering.

**Terminal-native TUI** — Differential rendering, theming, Nerd Font support. No Electron, no browser.

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
