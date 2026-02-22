<p align="center">
  <img src="https://github.com/nghyane/arcane/blob/main/assets/hero.png?raw=true" alt="Arcane">
</p>

<p align="center">
  <strong>AI coding agent for the terminal</strong>
</p>

<p align="center">
  <a href="https://github.com/nghyane/arcane"><img src="https://img.shields.io/badge/upstream-nghyane%2Foh--my--pi-58A6FF?style=flat&colorA=222222" alt="Upstream"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

## Why This Fork

This is an opinionated fork of [nghyane/arcane](https://github.com/nghyane/arcane) with structural changes that diverge too far from upstream for a PR:

- **Removed plan mode** entirely -- the feature added complexity without proportional value in practice
- **Removed worktree isolation** in task/subagent execution -- simplified the executor significantly (-2700 lines)
- **Added Code Mode** -- LLM writes JS to orchestrate tools in a single round-trip instead of sequential tool calls
- **Added undo_edit tool** -- allows the agent to revert its own edits
- **Rewrote system prompt** -- conventions, git hygiene, SSH guidance, agency balance
- **Ongoing dead code cleanup** -- removing unused types, rendering code, and stale references

Upstream bug fixes are merged regularly via merge commits.

## Table of Contents

- [Highlights](#highlights)
- [Installation](#installation)
- [Getting Started](#getting-started)
  - [Terminal Setup](#terminal-setup)
  - [API Keys & OAuth](#api-keys--oauth)
  - [First 15 Minutes (Recommended)](#first-15-minutes-recommended)
- [Usage](#usage)
  - [Slash Commands](#slash-commands)
  - [Editor Features](#editor-features)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Bash Mode](#bash-mode)
  - [Image Support](#image-support)
- [Sessions](#sessions)
  - [Session Management](#session-management)
  - [Context Compaction](#context-compaction)
  - [Branching](#branching)
  - [Autonomous Memory](#autonomous-memory)
- [Configuration](#configuration)
  - [Project Context Files](#project-context-files)
  - [Custom System Prompt](#custom-system-prompt)
  - [Custom Models and Providers](#custom-models-and-providers)
  - [Settings File](#settings-file)
- [Extensions](#extensions)
  - [Themes](#themes)
  - [Custom Slash Commands](#custom-slash-commands)
  - [Skills](#skills)
  - [Hooks](#hooks)
  - [Custom Tools](#custom-tools)
- [CLI Reference](#cli-reference)
- [Tools](#tools)
- [Programmatic Usage](#programmatic-usage)
  - [SDK](#sdk)
  - [RPC Mode](#rpc-mode)
  - [HTML Export](#html-export)
- [Philosophy](#philosophy)
- [Development](#development)
- [Monorepo Packages](#monorepo-packages)
- [License](#license)

---

## Highlights

Everything from [upstream](https://github.com/nghyane/arcane), plus:

- **Code Mode** -- LLM writes JS to orchestrate tools in parallel (`Promise.all`) instead of sequential round-trips. Typed API auto-generated from tool schemas.
- **Undo Edit** -- agent can revert its own file edits
- **Simplified Task/Subagent** -- removed worktree isolation, streamlined executor (-2700 lines)

Inherited from upstream:

- **Hashline Edits** -- content-hash anchors for every line, no "string not found" failures
- **LSP Integration** -- format-on-write, diagnostics, hover, references, 40+ languages
- **Python Tool** -- persistent IPython kernel with streaming output and rich display
- **Commit Tool** -- agentic git analysis, split commits, hunk-level staging, changelog generation
- **Task Tool** -- parallel subagent execution with 6 bundled agents
- **Browser Tool** -- Puppeteer with 14 stealth scripts, accessibility snapshots
- **SSH Tool** -- persistent connections, OS/shell detection, SSHFS mounts
- **Web Search & Fetch** -- multi-provider search, site-specific extractors, package registry support
- **TTSR** -- zero-cost rules that inject only when regex triggers match model output
- **Universal Config Discovery** -- loads config from Claude Code, Cursor, Windsurf, Gemini, Codex, Cline, Copilot
- **MCP & Plugins** -- stdio/HTTP transports, hot-loadable plugins
- **Native Engine** -- 7500 lines of Rust for grep, shell, text, keys, highlighting, image, PTY
- **65+ themes**, model roles, multi-credential rotation, image generation, TUI with powerline footer

---

## Installation

### Via Bun (recommended)

Requires [Bun](https://bun.sh) **>= 1.3.7**:

```bash
bun install -g @nghyane/arcane
```

### Via installer script

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/nghyane/arcane/main/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/nghyane/arcane/main/scripts/install.ps1 | iex
```

By default, the installer uses Bun when available (and compatible), otherwise installs the prebuilt binary.

Options:

- POSIX (`install.sh`): `--source`, `--binary`, `--ref <ref>`, `-r <ref>`
- PowerShell (`install.ps1`): `-Source`, `-Binary`, `-Ref <ref>`
- `--ref`/`-Ref` with binary mode must reference a release tag; branch/commit refs require source mode

Set custom install directory with `PI_INSTALL_DIR`.

Examples:

```bash
# Source install (Bun)
curl -fsSL https://raw.githubusercontent.com/nghyane/arcane/main/scripts/install.sh | sh -s -- --source

# Install release tag via binary
curl -fsSL https://raw.githubusercontent.com/nghyane/arcane/main/scripts/install.sh | sh -s -- --binary --ref v3.20.1

# Install branch/commit via source
curl -fsSL https://raw.githubusercontent.com/nghyane/arcane/main/scripts/install.sh | sh -s -- --source --ref main
```

```powershell
# Install release tag via binary
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nghyane/arcane/main/scripts/install.ps1))) -Binary -Ref v3.20.1
# Install branch/commit via source
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nghyane/arcane/main/scripts/install.ps1))) -Source -Ref main
```

### Via [mise](https://mise.jdx.dev)

```bash
mise use -g github:nghyane/arcane
```

### Manual download

Download binaries directly from [GitHub Releases](https://github.com/nghyane/arcane/releases/latest).

---

## Getting Started

### Terminal Setup

Pi uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

**Kitty, iTerm2:** Work out of the box.

**Ghostty:** Add to your Ghostty config (`~/.config/ghostty/config`):

```
keybind = alt+backspace=text:\x1b\x7f
keybind = shift+enter=text:\n
```

**wezterm:** Create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

**Windows Terminal:** Does not support the Kitty keyboard protocol. Shift+Enter cannot be distinguished from Enter. Use Ctrl+Enter for multi-line input instead. All other keybindings work correctly.

### API Keys & OAuth

**Option 1: Environment variables** (common examples)

| Provider   | Environment Variable |
| ---------- | -------------------- |
| Anthropic  | `ANTHROPIC_API_KEY`  |
| OpenAI     | `OPENAI_API_KEY`     |
| Google     | `GEMINI_API_KEY`     |
| Mistral    | `MISTRAL_API_KEY`    |
| Groq       | `GROQ_API_KEY`       |
| Cerebras   | `CEREBRAS_API_KEY`   |
| Hugging Face (`huggingface`) | `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN` |
| Synthetic  | `SYNTHETIC_API_KEY`  |
| NVIDIA (`nvidia`) | `NVIDIA_API_KEY` |
| NanoGPT (`nanogpt`) | `NANO_GPT_API_KEY` |
| Together (`together`) | `TOGETHER_API_KEY` |
| Ollama (`ollama`) | `OLLAMA_API_KEY` *(optional)* |
| LiteLLM (`litellm`) | `LITELLM_API_KEY` |
| Xiaomi MiMo (`xiaomi`) | `XIAOMI_API_KEY` |
| Moonshot (`moonshot`) | `MOONSHOT_API_KEY` |
| Venice (`venice`) | `VENICE_API_KEY` |
| xAI        | `XAI_API_KEY`        |
| OpenRouter | `OPENROUTER_API_KEY` |
| Z.AI       | `ZAI_API_KEY`        |
| Qwen Portal (`qwen-portal`) | `QWEN_OAUTH_TOKEN` or `QWEN_PORTAL_API_KEY` |
| vLLM (`vllm`) | `VLLM_API_KEY` |
| Cloudflare AI Gateway (`cloudflare-ai-gateway`) | `CLOUDFLARE_AI_GATEWAY_API_KEY` |
| Qianfan (`qianfan`) | `QIANFAN_API_KEY` |

See [Environment Variables](docs/environment-variables.md) for the full list.

**Option 2: `/login` (interactive auth / API key setup)**

Use `/login` with supported providers:

- Anthropic (Claude Pro/Max)
- ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Cloud Code Assist (Gemini CLI)
- Antigravity (Gemini 3, Claude, GPT-OSS)
- Cursor
- Kimi Code
- Perplexity
- NVIDIA (`nvidia`)
- NanoGPT (`nanogpt`)
- Hugging Face Inference (`huggingface`)
- OpenCode Zen
- Qianfan (`qianfan`)
- Ollama (local / self-hosted, `ollama`)
- vLLM (local OpenAI-compatible, `vllm`)
- Z.AI (GLM Coding Plan)
- Synthetic
- Together (`together`)
- LiteLLM (`litellm`)
- Xiaomi MiMo (`xiaomi`)
- Moonshot (Kimi API, `moonshot`)
- Venice (`venice`)
- MiniMax Coding Plan (International / China)
- Qwen Portal (`qwen-portal`)
- Cloudflare AI Gateway (`cloudflare-ai-gateway`)

For `ollama`, API key is optional. Leave it unset for local no-auth instances, or set `OLLAMA_API_KEY` for authenticated hosts.
For `vllm`, paste your key in `/login` (or use `VLLM_API_KEY`). For local no-auth servers, any placeholder value works (for example `vllm-local`).
For `nanogpt`, `/login nanogpt` opens `https://nano-gpt.com/api` and prompts for your `sk-...` key (or set `NANO_GPT_API_KEY`). Login validates the key via NanoGPT's models endpoint (not a fixed model entitlement).
For `cloudflare-ai-gateway`, set provider base URL to
`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
(for example in `~/.arcane/agent/models.yml`).
```bash
arc
/login
```

**Credential behavior:**

- `/login` appends credentials for the provider (it does not wipe existing entries)
- `/logout` clears saved credentials for the selected provider
- Credentials are stored in `~/.arcane/agent/agent.db`
- For the same provider, saved API key credentials are selected before OAuth credentials

### First 15 Minutes (Recommended)

This is the practical onboarding flow for new users.

#### 1) Set up providers

- **API keys** (fastest): export `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.
- **OAuth subscriptions**: run `/login` and authenticate with your provider account

#### 2) Configure model roles via `/model`

Use `/model` in the TUI and assign role models:

- `default` → normal implementation work
- `smol` → fast/cheap exploration and lightweight tasks
- `slow` → deep reasoning for complex debugging/refactors
- `commit` → model used by commit/changelog workflows

This setup is interactive and persisted for you.

#### 3) Review context via `/extensions`

If context usage is unexpectedly high, inspect discovered external provider assets (rules/prompts/context/hooks/extensions).

Run `/extensions` and:

- Browse provider tabs (`Tab` / `Shift+Tab`)
- Inspect each item source (`via <provider>` + file path)
- Disable full providers or specific items you don't want (`Space`)

---

## Usage

### Slash Commands

These are **in-chat slash commands** (not CLI subcommands).
| Command | Description |
| ------- | ----------- |
| `/settings` | Open settings menu |
| `/model` (`/models`) | Open model selector |
| `/export [path]` | Export session to HTML |
| `/dump` | Copy session transcript to clipboard |
| `/share` | Upload session as a secret gist |
| `/session` | Show session info and usage |
| `/usage` | Show provider usage and limits |
| `/hotkeys` | Show keyboard shortcuts |
| `/extensions` (`/status`) | Open Extension Control Center |
| `/changelog` | Show changelog entries |
| `/tree` | Navigate session tree |
| `/branch` | Open branch selector (tree or message selector, based on settings) |
| `/fork` | Fork from a previous message |
| `/resume` | Open session picker |
| `/new` | Start a new session |
| `/compact [focus]` | Compact context manually |
| `/handoff [focus]` | Hand off context to a new session |
| `/browser [headless\|visible]` | Toggle browser mode |
| `/mcp ...` | Manage MCP servers |
| `/memory ...` | Inspect/clear/rebuild memory state |
| `/move <path>` | Move current session to a different cwd |
| `/background` (`/bg`) | Detach UI and continue in background |
| `/debug` | Open debug tools |
| `/copy` | Copy last agent message |
| `/login` / `/logout` | OAuth login/logout |
| `/exit` (`/quit`) | Exit interactive mode |

Bundled custom slash commands include `/review` (interactive code review launcher).

### Editor Features

**File reference (`@`):** Type `@` to fuzzy-search project files. Respects `.gitignore`.

**Path completion (Tab):** Complete relative paths, `../`, `~/`, etc.

**Drag & drop:** Drag files from your file manager into the terminal.

**Multi-line paste:** Pasted content is collapsed in preview but sent in full.

**Message queuing:** Submit messages while the agent is working; queue behavior is configurable in `/settings`.

### Keyboard Shortcuts

**Navigation:**

| Key                      | Action                                       |
| ------------------------ | -------------------------------------------- |
| Arrow keys               | Move cursor / browse history (Up when empty) |
| Option+Left/Right        | Move by word                                 |
| Ctrl+A / Home / Cmd+Left | Start of line                                |
| Ctrl+E / End / Cmd+Right | End of line                                  |

**Editing:**

| Key                       | Action                  |
| ------------------------- | ----------------------- |
| Enter                     | Send message            |
| Shift+Enter / Alt+Enter   | New line                |
| Ctrl+W / Option+Backspace | Delete word backwards   |
| Ctrl+U                    | Delete to start of line |
| Ctrl+K                    | Delete to end of line   |

**Other:**

| Key                   | Action                                                    |
| --------------------- | --------------------------------------------------------- |
| Tab                   | Path completion / accept autocomplete                     |
| Escape                | Cancel autocomplete / abort streaming                     |
| Ctrl+C                | Clear editor (first) / exit (second)                      |
| Ctrl+D                | Exit (when editor is empty)                               |
| Ctrl+Z                | Suspend to background (use `fg` in shell to resume)       |
| Shift+Tab             | Cycle thinking level                                      |
| Ctrl+P / Shift+Ctrl+P | Cycle role models (slow/default/smol), temporary on shift |
| Alt+P                 | Select model temporarily                                  |
| Ctrl+L                | Open model selector                                       |
| Ctrl+R                | Search prompt history                                     |
| Ctrl+O                | Toggle tool output expansion                              |
| Ctrl+T                | Toggle todo list expansion                                |
| Ctrl+G                | Edit message in external editor (`$VISUAL` or `$EDITOR`)  |
| Alt+H                 | Toggle speech-to-text recording                           |

### Bash Mode

Prefix commands with `!` to execute them and include output in context:

```bash
!git status
!ls -la
```

Use `!!` to execute but **exclude output from LLM context**:

```bash
!!git status
```

Output streams in real-time. Press Escape to cancel.

### Image Support

**Attach images by reference:**

```text
What's in @/path/to/image.png?
```

Or paste/drop images directly (`Ctrl+V` or drag-and-drop).

Supported formats: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`

Toggle inline images via `/settings` or set `terminal.showImages: false`.

---

## Sessions

Sessions are stored as JSONL with a tree structure for branching and replay.

See [docs/session.md](docs/session.md) for the file format and API.

### Session Management

Sessions auto-save to `~/.arcane/agent/sessions/` (grouped by working directory).

```bash
arc --continue             # Continue most recent session
arc -c

arc --resume               # Open session picker
arc -r

arc --resume <id-prefix>   # Resume by session ID prefix
arc --resume <path>        # Resume by explicit .jsonl path
arc --session <value>      # Alias of --resume
arc --no-session    # Ephemeral mode (don't save)
```

Session IDs are Snowflake-style hex IDs (not UUIDs).

### Context Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent context.

**Manual:** `/compact` or `/compact Focus on the API changes`

**Automatic:** Enable via `/settings`.

- **Overflow recovery**: model returns context overflow; compact and retry.
- **Threshold maintenance**: context exceeds configured headroom after a successful turn.

**Configuration** (`~/.arcane/agent/config.yml`):

```yaml
compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000
  autoContinue: true
```

See [docs/compaction.md](docs/compaction.md) for internals and hook integration.

### Branching

**In-place navigation (`/tree`):** Navigate the session tree without creating new files.

- Search by typing, page with ←/→
- Filter modes (`Ctrl+O`): default → no-tools → user-only → labeled-only → all
- Press `Shift+L` to label entries as bookmarks

**Create new session (`/branch` / `/fork`):** Branch to a new session file from a selected previous message.

### Autonomous Memory

When enabled, the agent extracts durable knowledge from past sessions and injects it at startup. The pipeline runs in the background and never blocks the active session.

Memory is isolated per project (working directory) and stored under `~/.arcane/agent/memories/`. At session start, a compact summary is injected into the system prompt. The agent can read deeper context via `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.

Manage via the `/memory` slash command:

- `/memory view` — show current injection payload
- `/memory clear` — delete all memory data and artifacts
- `/memory enqueue` — force consolidation at next startup

> See [Memory Documentation](docs/memory.md).

---

## Configuration

### Project Context Files

arc discovers project context from supported config directories (for example `.arcane`, `.claude`, `.codex`, `.gemini`).

Common files:

- `AGENTS.md`
- `CLAUDE.md`

Use these for:

- Project instructions and guardrails
- Common commands and workflows
- Architecture documentation
- Coding/testing conventions

### Custom System Prompt

Replace the default system prompt by creating `SYSTEM.md`:

1. **Project-local:** `.arcane/SYSTEM.md` (takes precedence)
2. **Global:** `~/.arcane/agent/SYSTEM.md` (fallback)
   `--system-prompt` overrides both files. Use `--append-system-prompt` to append additional instructions.

### Custom Models and Providers

Add custom providers/models via `~/.arcane/agent/models.yml`.

`models.json` is still supported for legacy configs, but `models.yml` is the modern format.

> See [models.yml provider integration guide](docs/models.md) for schema and merge behavior.

```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434/v1
    apiKey: OLLAMA_API_KEY
    api: openai-completions
    models:
      - id: llama-3.1-8b
        name: Llama 3.1 8B (Local)
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 32000
```

**Supported APIs:** `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`

### Settings File

Global settings are stored in:

- `~/.arcane/agent/config.yml`

Project overrides are loaded from discovered project settings files (commonly `.arcane/settings.json`).

Global `config.yml` example:

```yaml
theme:
  dark: titanium
  light: light

modelRoles:
  default: anthropic/claude-sonnet-4-20250514

defaultThinkingLevel: medium
enabledModels:
  - anthropic/*
  - "*gpt*"
  - gemini-2.5-pro:high

steeringMode: one-at-a-time
followUpMode: one-at-a-time
interruptMode: immediate

shellPath: C:\\path\\to\\bash.exe
hideThinkingBlock: false
collapseChangelog: false

disabledProviders: []
disabledExtensions: []

compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000

skills:
  enabled: true

retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000

terminal:
  showImages: true
```

Legacy migration notes:

- `settings.json` → `config.yml`
- `queueMode` → `steeringMode`
- flat `theme: "..."` → `theme.dark` / `theme.light`

---

## Extensions

### Themes

Built-in themes include `dark`, `light`, and many bundled variants.

Select theme via `/settings` or set in `~/.arcane/agent/config.yml`:

```yaml
theme:
  dark: titanium
  light: light
```

**Custom themes:** create `~/.arcane/agent/themes/*.json`.

> See [Theme Documentation](docs/theme.md).

### Custom Slash Commands

Define reusable prompt commands as Markdown files:

- Global: `~/.arcane/agent/commands/*.md`
- Project: `.arcane/commands/*.md`

```markdown
---
description: Review staged git changes
---

Review the staged changes (`git diff --cached`). Focus on:

- Bugs and logic errors
- Security issues
- Error handling gaps
```

Filename (without `.md`) becomes the command name.

Argument placeholders:

- `$1`, `$2`, ... positional arguments
- `$@` and `$ARGUMENTS` for all arguments joined

TypeScript custom commands are also supported:

- `~/.arcane/agent/commands/<name>/index.ts`
- `.arcane/commands/<name>/index.ts`

Bundled TypeScript command: `/review`.

### Skills

Skills are capability packages loaded on-demand.

Common locations:

- `~/.arcane/agent/skills/*/SKILL.md`
- `.arcane/skills/*/SKILL.md`
- `~/.claude/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`
- `~/.codex/skills/*/SKILL.md`, `.codex/skills/*/SKILL.md`

```markdown
---
name: brave-search
description: Web search via Brave Search API.
---

# Brave Search
```

`description` drives matching; `name` defaults to the folder name when omitted.

Disable skills with `arc --no-skills` or `skills.enabled: false`.

> See [Skills Documentation](docs/skills.md).

### Hooks

Hooks are TypeScript modules that subscribe to lifecycle events.

Hook locations:

- Global: `~/.arcane/agent/hooks/pre/*.ts`, `~/.arcane/agent/hooks/post/*.ts`
- Project: `.arcane/hooks/pre/*.ts`, `.arcane/hooks/post/*.ts`
- CLI: `--hook <path>`

```typescript
import type { HookAPI } from "@nghyane/arcane/hooks";

export default function (arcane: HookAPI) {
	arcane.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && /sudo/.test(event.input.command as string)) {
			const ok = await ctx.ui.confirm("Allow sudo?", event.input.command as string);
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
```

Inject messages from hooks with:

```ts
arcane.sendMessage(message, { triggerTurn: true });
```

> See [Hooks Documentation](docs/hooks.md) and [examples/hooks/](packages/coding-agent/examples/hooks/).

### Custom Tools

Custom tools extend the built-in toolset and are callable by the model.

Auto-discovered locations:

- Global: `~/.arcane/agent/tools/*/index.ts`
- Project: `.arcane/tools/*/index.ts`

```typescript
import { Type } from "@sinclair/typebox";
import type { CustomToolFactory } from "@nghyane/arcane";
const factory: CustomToolFactory = () => ({
	name: "greet",
	label: "Greeting",
	description: "Generate a greeting",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params) {
		const { name } = params as { name: string };
		return { content: [{ type: "text", text: `Hello, ${name}!` }] };
	},
});
export default factory;
```

> See [Custom Tools Documentation](docs/custom-tools.md) and [examples/custom-tools/](packages/coding-agent/examples/custom-tools/).

---

## CLI Reference

```bash
arc [options] [@files...] [messages...]
arc <command> [args] [flags]
```

### Options

| Option                                | Description                                                        |
| ------------------------------------- | ------------------------------------------------------------------ |
| `--provider <name>`                   | Provider hint (legacy; prefer `--model`)                           |
| `--model <id>`                        | Model ID (supports fuzzy match)                                    |
| `--smol <id>`                         | Override the `smol` role model for this run                        |
| `--slow <id>`                         | Override the `slow` role model for this run                        |
| `--models <patterns>`                 | Comma-separated model patterns for role cycling                    |
| `--list-models [pattern]`             | List available models (optional fuzzy filter)                      |
| `--thinking <level>`                  | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--api-key <key>`                     | API key (overrides environment/provider lookup)                    |
| `--system-prompt <text\|file>`        | Replace system prompt                                              |
| `--append-system-prompt <text\|file>` | Append to system prompt                                            |
| `--mode <mode>`                       | Output mode: `text`, `json`, `rpc`                                 |
| `--print`, `-p`                       | Non-interactive: process prompt and exit                           |
| `--continue`, `-c`                    | Continue most recent session                                       |
| `--resume`, `-r [id\|path]`           | Resume by ID prefix/path (or open picker if omitted)               |
| `--session <value>`                   | Alias of `--resume`                                                |
| `--session-dir <dir>`                 | Directory for session storage and lookup                           |
| `--no-session`                        | Don't save session                                                 |
| `--tools <tools>`                     | Restrict to comma-separated built-in tool names                    |
| `--no-tools`                          | Disable all built-in tools                                         |
| `--no-lsp`                            | Disable LSP integration                                            |
| `--no-pty`                            | Disable PTY-based interactive bash execution                       |
| `--extension <path>`, `-e`            | Load extension file (repeatable)                                   |
| `--hook <path>`                       | Load hook/extension file (repeatable)                              |
| `--no-extensions`                     | Disable extension discovery (`-e` paths still load)                |
| `--no-skills`                         | Disable skills discovery and loading                               |
| `--skills <patterns>`                 | Comma-separated glob patterns to filter skills                     |
| `--no-rules`                          | Disable rules discovery and loading                               |
| `--allow-home`                        | Allow starting from home dir without auto-chdir                    |
| `--no-title`                          | Disable automatic session title generation                         |
| `--export <file> [output]`            | Export session to HTML                                             |
| `--help`, `-h`                        | Show help                                                          |
| `--version`, `-v`                     | Show version                                                       |

### Subcommands

\`arc\` also ships dedicated subcommands:

- `commit`
- `config`
- `grep`
- `jupyter`
- `plugin`
- `search` (alias: `q`)
- `setup`
- `shell`
- `stats`
- `update`

### File Arguments

Include files with `@` prefix:

```bash
arc @prompt.md "Answer this"
arc @screenshot.png "What's in this image?"
arc @requirements.md @design.png "Implement this"
```

Text files are wrapped in `<file ...>` blocks. Images are attached.

### Examples

```bash
# Interactive mode
arc
# Non-interactive
arc -p "List all .ts files in src/"
arc -c "What did we discuss?"
# Resume by ID prefix
arc -r abc123

# Model cycling with patterns
arc --models "sonnet:high,haiku:low"

# Restrict toolset for read-only review
arc --tools read,grep,find -p "Review the architecture"
# Export session
arc --export session.jsonl output.html
```

### Environment Variables

| Variable                                          | Description                                             |
| ------------------------------------------------- | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.       | Provider credentials                                    |
| `PI_CODING_AGENT_DIR`                             | Override agent data directory (default: `~/.arcane/agent`) |
| `PI_PACKAGE_DIR`                                  | Override package directory resolution                   |
| `PI_SMOL_MODEL`, `PI_SLOW_MODEL` | Role-model overrides                                    |
| `PI_NO_PTY`                                       | Disable PTY-based bash execution                        |
| `VISUAL`, `EDITOR`                                | External editor for Ctrl+G                              |

See [Environment Variables](docs/environment-variables.md) for the complete reference.

---

## Tools

Use `--tools <list>` to restrict available built-in tools.

### Built-in Tool Names (`--tools`)

| Tool         | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `ask`        | Ask the user structured follow-up questions (interactive mode) |
| `bash`       | Execute shell commands                                         |
| `python`     | Execute Python code in IPython kernel                          |
| `calc`       | Deterministic calculator/evaluator                             |
| `ssh`        | Execute commands on configured SSH hosts                       |
| `edit`       | In-place file editing (hashline/patch/replace modes)           |
| `find`       | Find files by glob pattern                                     |
| `grep`       | Search file content                                            |
| `lsp`        | Language server actions                                        |
| `notebook`   | Edit Jupyter notebooks                                         |
| `read`       | Read files/directories (default text cap: 3000 lines)          |
| `browser`    | Browser automation tool (model-facing name: `puppeteer`)       |
| `task`       | Launch subagents                                               |
| `todo_write` | Track task progress                                            |
| `fetch`      | Fetch and extract URL content                                  |
| `web_search` | Search the web                                                 |
| `write`      | Create/overwrite files                                         |

Notes:

- Some tools are setting-gated (`calc`, `browser`, etc.)
- `ask` requires interactive UI
- `ssh` requires configured SSH hosts

Example:

`arc --tools read,grep,find -p "Review this codebase"`

For adding new tools, see [Custom Tools](#custom-tools).

---

## Programmatic Usage

### SDK

For embedding arcane in Node.js/TypeScript applications, use the SDK:

```typescript
import { ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage } from "@nghyane/arcane";
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await session.prompt("What files are in the current directory?");
```

The SDK provides control over:

- Model selection and thinking level
- System prompt (replace or append)
- Built-in/custom tools
- Hooks, skills, context files, slash commands
- Session persistence (`SessionManager`)
- Settings (`Settings`)
- API key and OAuth resolution

> See [SDK Documentation](docs/sdk.md) and [examples/sdk/](packages/coding-agent/examples/sdk/).

### RPC Mode

For embedding from other languages or process isolation:

```bash
arc --mode rpc --no-session
```

Send JSON commands on stdin:

```json
{"id":"req-1","type":"prompt","message":"List all .ts files"}
{"id":"req-2","type":"abort"}
```

Responses are emitted as `type: "response"`; session events stream on stdout as they occur.

> See [RPC Documentation](docs/rpc.md) for the full protocol.

### HTML Export

```bash
arc --export session.jsonl              # Auto-generated filename
arc --export session.jsonl output.html  # Custom filename
```

Works with session files and JSON event logs from `--mode json`.

---

## Philosophy

arc originates from [arcane](https://github.com/badlogic/arcane) by [Mario Zechner](https://github.com/mariozechner), extended by [nghyane](https://github.com/nghyane) into a batteries-included coding agent. This fork strips out features that added complexity without clear payoff and adds opinionated improvements.

Key ideas:

- Terminal-first interactive UX for real coding work
- Practical built-ins (tools, sessions, branching, subagents, extensibility)
- Simplicity over configurability -- remove features rather than hide them behind flags

---

## Development

### Debug Command

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

---

## Monorepo Packages

| Package                                                   | Description                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| **[@nghyane/arcane-ai](packages/ai)**                        | Multi-provider LLM client with streaming and model/provider integration    |
| **[@nghyane/arcane-agent](packages/agent)**             | Agent runtime with tool calling and state management                       |
| **[@nghyane/arcane-codemode](packages/codemode)**            | Code Mode: LLM writes JS to orchestrate tools in a single round-trip      |
| **[@nghyane/arcane](packages/coding-agent)**    | Interactive coding agent CLI and SDK                                       |
| **[@nghyane/arcane-tui](packages/tui)**                      | Terminal UI library with differential rendering                            |
| **[@nghyane/arcane-natives](packages/natives)**              | N-API bindings for grep, shell, image, text, syntax highlighting, and more |
| **[@nghyane/arcane-stats](packages/stats)**                 | Local observability dashboard for AI usage statistics                      |
| **[@nghyane/arcane-utils](packages/utils)**                  | Shared utilities (logging, streams, dirs/env/process helpers)              |
| **[@nghyane/arcane-swarm](packages/swarm-extension)** | Swarm orchestration extension package                                      |

### Rust Crates

| Crate                                                         | Description                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **[arcane-natives](crates/arcane-natives)**                           | Core Rust native addon used by `@nghyane/arcane-natives`                                        |
| **[brush-core-vendored](crates/brush-core-vendored)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution |
| **[brush-builtins-vendored](crates/brush-builtins-vendored)** | Vendored bash builtins (cd, echo, test, printf, read, export, etc.)                          |

---

## License

MIT. See [LICENSE](LICENSE).

Original work copyright (c) [Mario Zechner](https://github.com/mariozechner) and [Can Boluk](https://github.com/nghyane).
