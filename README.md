<p align="center">
  <video src="https://github.com/nghyane/arcane/blob/main/assets/demo-hero.mp4?raw=true" width="720" autoplay loop muted playsinline></video>
</p>

<p align="center">
  <strong>The coding agent where the LLM writes code to use its own tools.</strong>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://www.npmjs.com/package/@nghyane/arcane"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane?style=flat&colorA=222222&label=%40nghyane%2Farcane" alt="npm"></a>
</p>

---

Every coding agent today works the same way: the LLM calls one tool, waits for the result, calls the next tool, waits again. A simple "read 3 files and edit 2 of them" takes 5+ round-trips — each one burning tokens on the overhead of a full API call.

Arcane is different. Instead of calling tools one at a time, the LLM **writes a JavaScript program** that orchestrates all of its tools in a single turn.

## Code Mode

The core idea: the LLM emits an async JS function that calls tool APIs directly — reads, edits, greps, spawns subagents — composing them with `Promise.all`, conditionals, and loops. One LLM turn does the work of many.


### Traditional agent

```
User: "Read src/app.ts and src/utils.ts, then fix the import in app.ts"

Turn 1 -> tool_call: read("src/app.ts")        -> wait -> result
Turn 2 -> tool_call: read("src/utils.ts")       -> wait -> result
Turn 3 -> tool_call: edit("src/app.ts", ...)    -> wait -> result
Turn 4 -> tool_call: diagnostics("src/app.ts")  -> wait -> result

4 round-trips. 4x API overhead. Sequential.
```

### Arcane (Code Mode)

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

**1 LLM turn. Parallel reads. Fewer tokens. Faster.**

The LLM has full control flow — it can branch on file contents, fan out subagents with `Promise.all`, retry on diagnostics errors, and compose multi-step workflows that would take a traditional agent 10+ turns.

## Hashline Edits

Every other agent anchors edits to **line numbers**. Problem: line numbers shift the moment anything else touches the file. Concurrent edits, formatter runs, even the agent's own previous edits can invalidate them.

Arcane anchors edits to **hashline tags** — short content-derived hashes attached to each line (e.g. `3#XK`). These tags are stable: they identify lines by content, not position. Edits survive reordering, insertion, and concurrent modification.


```javascript
// Tags are content-hashed — they don't shift when lines move
await codemode.edit({
  path: "src/config.ts",
  edits: [
    { op: "set", tag: "12#QJ", content: 'const PORT = 8080;' },
    { op: "replace", first: "20#MZ", last: "25#BQ", content: null }, // delete range
  ],
});
```

No line-number math. No diff fragility. Edits just work.

## Subagents

The LLM can spawn dedicated subagents for parallel, specialized work:

| Subagent | Model | Purpose |
|---|---|---|
| **Task** | Same as main | Parallel subtasks with isolated context |
| **Oracle** | GPT-5.3 | Cross-model reasoning and second opinions |
| **Reviewer** | Gemini | Dedicated code review with diff analysis |
| **Explorer** | Fast model | Codebase exploration and discovery |
| **Librarian** | Fast model | Documentation and API lookup |

Subagents run in parallel via `Promise.all` — the main agent doesn't block waiting for them.

## More Features

- **Multi-provider** — Claude, GPT, Gemini, Codex, 25+ providers with OAuth login or API keys
- **Sessions** — persistent conversations with branching, compaction, and memory
- **Extensions** — themes, custom tools, slash commands, hooks, skills
- **Full TUI** — syntax highlighting, diffs, interactive components, image support
- **LSP integration** — diagnostics, go-to-definition, references, rename
- **Browser automation** — Puppeteer-based web interaction
- **SDK & RPC** — programmatic access and JSON-RPC mode

## Quick Start

```bash
bun install -g @nghyane/arcane
```

### Authentication

The fastest way — **OAuth login**. Use your existing Anthropic, Codex, Gemini CLI, Antigravity, GitHub Copilot, Cursor, Perplexity, or [25+ other providers](packages/ai/src/utils/oauth) — no API keys needed:

```bash
arc auth login
```

Or use API keys directly:

```bash
export ANTHROPIC_API_KEY="..."   # Claude
export OPENAI_API_KEY="..."      # GPT / Codex
export GEMINI_API_KEY="..."      # Gemini
```

### Run

```bash
arc                          # interactive mode
arc "fix the failing tests"  # one-shot mode
arc --model sonnet           # pick a model
```

<details>
<summary><strong>Build from source</strong></summary>

```bash
git clone https://github.com/nghyane/arcane.git
cd arcane
bun install
bun link --cwd packages/coding-agent
```

</details>

## Usage

<!-- TODO: replace with VHS demo -->

<details>
<summary><strong>Slash commands</strong></summary>

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

</details>

<details>
<summary><strong>Keyboard shortcuts</strong></summary>

| Key | Action |
|---|---|
| `Ctrl+J` | Submit message |
| `Escape` | Abort current operation |
| `Ctrl+L` | Clear screen |
| `Tab` | Accept autocomplete |
| `Up/Down` | Message history |

</details>

<details>
<summary><strong>CLI flags</strong></summary>

```
arc [message]              Start interactive or one-shot session
arc auth login             Authenticate with OAuth
arc doctor                 Run diagnostics
arc commit                 AI-powered commit messages
arc stats                  Usage dashboard
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
| `--rpc` | JSON-RPC over stdin/stdout |

</details>

<details>
<summary><strong>Configuration</strong></summary>

Global config lives in `~/.arcane/agent/`. Project-specific files go in the project root or `.arcane/` directory:

| File | Purpose |
|---|---|
| `AGENTS.md` | Project-specific instructions |
| `SYSTEM.md` | Custom system prompt (appended) |
| `models.yml` | Custom model/provider configuration |
| `settings.yml` | Agent settings |

</details>

<details>
<summary><strong>SDK</strong></summary>

```typescript
import { createAgentSession, discoverAuthStorage, discoverModels } from "@nghyane/arcane";

const auth = await discoverAuthStorage();
const models = await discoverModels(auth);
const session = await createAgentSession({ auth, models });

for await (const event of session.sendMessage("Hello")) {
  // handle events
}
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
| [`arcane-natives`](crates/arcane-natives) | Rust crate for performance-critical ops |

<details>
<summary><strong>npm versions</strong></summary>

<p>
  <a href="https://www.npmjs.com/package/@nghyane/arcane"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane?style=flat&colorA=222222&label=%40nghyane%2Farcane" alt="@nghyane/arcane"></a>
  <a href="https://www.npmjs.com/package/@nghyane/arcane-ai"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane-ai?style=flat&colorA=222222&label=%40nghyane%2Farcane-ai" alt="@nghyane/arcane-ai"></a>
  <a href="https://www.npmjs.com/package/@nghyane/arcane-agent"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane-agent?style=flat&colorA=222222&label=%40nghyane%2Farcane-agent" alt="@nghyane/arcane-agent"></a>
  <a href="https://www.npmjs.com/package/@nghyane/arcane-tui"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane-tui?style=flat&colorA=222222&label=%40nghyane%2Farcane-tui" alt="@nghyane/arcane-tui"></a>
  <a href="https://www.npmjs.com/package/@nghyane/arcane-natives"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane-natives?style=flat&colorA=222222&label=%40nghyane%2Farcane-natives" alt="@nghyane/arcane-natives"></a>
  <a href="https://www.npmjs.com/package/@nghyane/arcane-stats"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane-stats?style=flat&colorA=222222&label=%40nghyane%2Farcane-stats" alt="@nghyane/arcane-stats"></a>
  <a href="https://www.npmjs.com/package/@nghyane/arcane-utils"><img src="https://img.shields.io/npm/v/%40nghyane%2Farcane-utils?style=flat&colorA=222222&label=%40nghyane%2Farcane-utils" alt="@nghyane/arcane-utils"></a>
</p>

</details>

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
