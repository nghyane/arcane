# Environment Variables (Current Runtime Reference)

This reference is derived from current code paths in:

- `packages/coding-agent/src/**`
- `packages/ai/src/**` (provider/auth resolution used by coding-agent)
- `packages/utils/src/**` and `packages/tui/src/**` where those vars directly affect coding-agent runtime

It documents only active behavior.

## Resolution model and precedence

Most runtime lookups use `$env` from `@nghyane/arcane-utils` (`packages/utils/src/env.ts`).

`$env` loading order:

1. Existing process environment (`Bun.env`)
2. Project `.env` (`$PWD/.env`) for keys not already set
3. Home `.env` (`~/.env`) for keys not already set

Additional rule in `.env` files: `OMP_*` keys are mirrored to `ARCANE_*` keys during parse.

---

## 1) Model/provider authentication

These are consumed via `getEnvApiKey()` (`packages/ai/src/stream.ts`) unless noted otherwise.

### Core provider credentials

| Variable | Used for | Required when | Notes / precedence |
|---|---|---|---|
| `ANTHROPIC_OAUTH_TOKEN` | Anthropic API auth | Using Anthropic with OAuth token auth | Takes precedence over `ANTHROPIC_AARCANE_KEY` for provider auth resolution |
| `ANTHROPIC_AARCANE_KEY` | Anthropic API auth | Using Anthropic without OAuth token | Fallback after `ANTHROPIC_OAUTH_TOKEN` |
| `OPENAI_AARCANE_KEY` | OpenAI auth | Using OpenAI-family providers without explicit apiKey argument | Used by OpenAI Carcaneletions/Responses providers |
| `GEMINI_AARCANE_KEY` | Google Gemini auth | Using `google` provider models | Primary key for Gemini provider mapping |
| `GOOGLE_AARCANE_KEY` | Gemini image tool auth fallback | Using `gemini_image` tool without `GEMINI_AARCANE_KEY` | Used by coding-agent image tool fallback path |
| `GROQ_AARCANE_KEY` | Groq auth | Using Groq models |  |
| `CEREBRAS_AARCANE_KEY` | Cerebras auth | Using Cerebras models |  |
| `TOGETHER_AARCANE_KEY` | Together auth | Using `together` provider |  |
| `HUGGINGFACE_HUB_TOKEN` | Hugging Face auth | Using `huggingface` provider | Primary Hugging Face token env var |
| `HF_TOKEN` | Hugging Face auth | Using `huggingface` provider | Fallback when `HUGGINGFACE_HUB_TOKEN` is unset |
| `SYNTHETIC_AARCANE_KEY` | Synthetic auth | Using Synthetic models |  |
| `NVIDIA_AARCANE_KEY` | NVIDIA auth | Using `nvidia` provider |  |
| `NANO_GPT_AARCANE_KEY` | NanoGPT auth | Using `nanogpt` provider | |
| `VENICE_AARCANE_KEY` | Venice auth | Using `venice` provider |  |
| `LITELLM_AARCANE_KEY` | LiteLLM auth | Using `litellm` provider | OpenAI-compatible LiteLLM proxy key |
| `OLLAMA_AARCANE_KEY` | Ollama auth (optional) | Using `ollama` provider with authenticated hosts | Local Ollama usually runs without auth; any non-empty token works when a key is required |
| `XIAOMI_AARCANE_KEY` | Xiaomi MiMo auth | Using `xiaomi` provider |  |
| `MOONSHOT_AARCANE_KEY` | Moonshot auth | Using `moonshot` provider |  |
| `XAI_AARCANE_KEY` | xAI auth | Using xAI models |  |
| `OPENROUTER_AARCANE_KEY` | OpenRouter auth | Using OpenRouter models | Also used by image tool when preferred/auto provider is OpenRouter |
| `MISTRAL_AARCANE_KEY` | Mistral auth | Using Mistral models |  |
| `ZAI_AARCANE_KEY` | z.ai auth | Using z.ai models | Also used by z.ai web search provider |
| `MINIMAX_AARCANE_KEY` | MiniMax auth | Using `minimax` provider |  |
| `MINIMAX_CODE_AARCANE_KEY` | MiniMax Code auth | Using `minimax-code` provider |  |
| `MINIMAX_CODE_CN_AARCANE_KEY` | MiniMax Code CN auth | Using `minimax-code-cn` provider |  |
| `OPENCODE_AARCANE_KEY` | OpenCode auth | Using OpenCode models |  |
| `QIANFAN_AARCANE_KEY` | Qianfan auth | Using `qianfan` provider |  |
| `QWEN_OAUTH_TOKEN` | Qwen Portal auth | Using `qwen-portal` with OAuth token | Takes precedence over `QWEN_PORTAL_AARCANE_KEY` |
| `QWEN_PORTAL_AARCANE_KEY` | Qwen Portal auth | Using `qwen-portal` with API key | Fallback after `QWEN_OAUTH_TOKEN` |
| `VLLM_AARCANE_KEY` | vLLM auth/discovery opt-in | Using `vllm` provider (local OpenAI-compatible servers) | Any non-empty value works for no-auth local servers |
| `CURSOR_ACCESS_TOKEN` | Cursor provider auth | Using Cursor provider |  |
| `AI_GATEWAY_AARCANE_KEY` | Vercel AI Gateway auth | Using `vercel-ai-gateway` provider |  |
| `CLOUDFLARE_AI_GATEWAY_AARCANE_KEY` | Cloudflare AI Gateway auth | Using `cloudflare-ai-gateway` provider | Base URL must be configured as `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` |

### GitHub/Copilot token chains

| Variable | Used for | Chain |
|---|---|---|
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot provider auth | `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` |
| `GH_TOKEN` | Copilot fallback; GitHub API auth in web scraper | In web scraper: `GITHUB_TOKEN` → `GH_TOKEN` |
| `GITHUB_TOKEN` | Copilot fallback; GitHub API auth in web scraper | In web scraper: checked before `GH_TOKEN` |

---

## 2) Provider-specific runtime configuration

### Amazon Bedrock

| Variable | Default / behavior |
|---|---|
| `AWS_REGION` | Primary region source |
| `AWS_DEFAULT_REGION` | Fallback if `AWS_REGION` unset |
| `AWS_PROFILE` | Enables named profile auth path |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Enables IAM key auth path |
| `AWS_BEARER_TOKEN_BEDROCK` | Enables bearer token auth path |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | Enables ECS task credential path |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` | Enables web identity auth path |
| `AWS_BEDROCK_SKIP_AUTH` | If `1`, injects dummy credentials (proxy/non-auth scenarios) |
| `AWS_BEDROCK_FORCE_HTTP1` | If `1`, forces Node HTTP/1 request handler |

Region fallback in provider code: `options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

### Azure OpenAI Responses

| Variable | Default / behavior |
|---|---|
| `AZURE_OPENAI_AARCANE_KEY` | Required unless API key passed as option |
| `AZURE_OPENAI_AARCANE_VERSION` | Default `v1` |
| `AZURE_OPENAI_BASE_URL` | Direct base URL override |
| `AZURE_OPENAI_RESOURCE_NAME` | Used to construct base URL: `https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Optional mapping string: `modelId=deploymentName,model2=deployment2` |

Base URL resolution: option `azureBaseUrl` → env `AZURE_OPENAI_BASE_URL` → option/env resource name → `model.baseUrl`.

### Google Vertex AI

| Variable | Required? | Notes |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | Yes (unless passed in options) | Fallback: `GCLOUD_PROJECT` |
| `GCLOUD_PROJECT` | Fallback | Used as alternate project ID source |
| `GOOGLE_CLOUD_LOCATION` | Yes (unless passed in options) | No default in provider |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional | If set, file must exist; otherwise ADC fallback path is checked (`~/.config/gcloud/application_default_credentials.json`) |

### Kimi

| Variable | Default / behavior |
|---|---|
| `KIMI_CODE_OAUTH_HOST` | Primary OAuth host override |
| `KIMI_OAUTH_HOST` | Fallback OAuth host override |
| `KIMI_CODE_BASE_URL` | Overrides Kimi usage endpoint base URL (`usage/kimi.ts`) |

OAuth host chain: `KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`.

### Antigravity/Gemini image compatibility

| Variable | Default / behavior |
|---|---|
| `ARCANE_AI_ANTIGRAVITY_VERSION` | Overrides Antigravity user-agent version tag in Gemini CLI provider |

### OpenAI Codex responses (feature/debug controls)

| Variable | Behavior |
|---|---|
| `ARCANE_CODEX_DEBUG` | `1`/`true` enables Codex provider debug logging |
| `ARCANE_CODEX_WEBSOCKET` | `1`/`true` enables websocket transport preference |
| `ARCANE_CODEX_WEBSOCKET_V2` | `1`/`true` enables websocket v2 path |
| `ARCANE_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` | Positive integer override (default 300000) |
| `ARCANE_CODEX_WEBSOCKET_RETRY_BUDGET` | Non-negative integer override (default 5) |
| `ARCANE_CODEX_WEBSOCKET_RETRY_DELAY_MS` | Positive integer base backoff override (default 500) |

### Cursor provider debug

| Variable | Behavior |
|---|---|
| `DEBUG_CURSOR` | Enables provider debug logs; `2`/`verbose` for detailed payload snippets |
| `DEBUG_CURSOR_LOG` | Optional file path for JSONL debug log output |

### Promptt cache compatibility switch

| Variable | Behavior |
|---|---|
| `ARCANE_CACHE_RETENTION` | If `long`, enables long retention where supported (`anthropic`, `openai-responses`, Bedrock retention resolution) |

---

## 3) Web search subsystem

### Search provider credentials

| Variable | Used by |
|---|---|
| `EXA_AARCANE_KEY` | Exa search provider and Exa MCP tools |
| `BRAVE_AARCANE_KEY` | Brave search provider |
| `PERPLEXITY_AARCANE_KEY` | Perplexity search provider API-key mode |
| `ZAI_AARCANE_KEY` | z.ai search provider (also checks stored OAuth in `agent.db`) |
| `OPENAI_AARCANE_KEY` / Codex OAuth in DB | Codex search provider availability/auth |

### Anthropic web search auth chain

`packages/coding-agent/src/web/search/auth.ts` resolves Anthropic web-search credentials in this order:

1. `ANTHROPIC_SEARCH_AARCANE_KEY` (+ optional `ANTHROPIC_SEARCH_BASE_URL`)
2. `models.json` provider entry with `api: "anthropic-messages"`
3. Anthropic OAuth credentials from `agent.db` (must not expire within 5-minute buffer)
4. Generic Anthropic env fallback: provider key (`ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_AARCANE_KEY`) + optional `ANTHROPIC_BASE_URL`

Related vars:

| Variable | Default / behavior |
|---|---|
| `ANTHROPIC_SEARCH_AARCANE_KEY` | Highest-priority explicit search key |
| `ANTHROPIC_SEARCH_BASE_URL` | Defaults to `https://api.anthropic.com` when omitted |
| `ANTHROPIC_SEARCH_MODEL` | Defaults to `claude-haiku-4-5` |
| `ANTHROPIC_BASE_URL` | Generic fallback base URL for tier-4 auth path |

### Perplexity OAuth flow behavior flag

| Variable | Behavior |
|---|---|
| `ARCANE_AUTH_NO_BORROW` | If set, disables macOS native-app token borrowing path in Perplexity login flow |

---

## 4) Python tooling and kernel runtime

| Variable | Default / behavior |
|---|---|
| `ARCANE_PY` | Python tool mode override: `0`/`bash`=`bash-only`, `1`/`py`=`ipy-only`, `mix`/`both`=`both`; invalid values ignored |
| `ARCANE_PYTHON_SKIP_CHECK` | If `1`, skips Python kernel availability checks/warm checks |
| `ARCANE_PYTHON_GATEWAY_URL` | If set, uses external kernel gateway instead of local shared gateway |
| `ARCANE_PYTHON_GATEWAY_TOKEN` | Optional auth token for external gateway (`Authorization: token <value>`) |
| `ARCANE_PYTHON_IPC_TRACE` | If `1`, enables low-level IPC trace path in kernel module |
| `VIRTUAL_ENV` | Highest-priority venv path for Python runtime resolution |

Extra conditional behavior:

- If `BUN_ENV=test` or `NODE_ENV=test`, Python availability checks are treated as OK and warming is skipped.
- Python env filtering denies common API keys and allows safe base vars + `LC_`, `XDG_`, `ARCANE_` prefixes.

---

## 5) Agent/runtime behavior toggles

| Variable | Default / behavior |
|---|---|
| `ARCANE_FAST_MODEL` | Ephemeral model-role override for `fast` (CLI `--fast` takes precedence) |
| `ARCANE_SLOW_MODEL` | Ephemeral model-role override for `slow` (CLI `--slow` takes precedence) |
| `ARCANE_PLAN_MODEL` | Ephemeral model-role override for `plan` (CLI `--plan` takes precedence) |
| `ARCANE_NO_TITLE` | If set (any non-empty value), disables auto session title generation on first user message |
| `NULL_PROMPT` | If `true`, system promptt builder returns empty string |
| `ARCANE_BLOCKED_AGENT` | Blocks a specific subagent type in task tool |
| `ARCANE_SUBPROCESS_CMD` | Overrides subagent spawn command (`arcane` / `arcane.cmd` resolution bypass) |
| `ARCANE_TASK_MAX_OUTPUT_BYTES` | Max captured output bytes per subagent (default `500000`) |
| `ARCANE_TASK_MAX_OUTPUT_LINES` | Max captured output lines per subagent (default `5000`) |
| `ARCANE_TIMING` | If `1`, enables startup/tool timing instrumentation logs |
| `ARCANE_DEBUG_STARTUP` | Enables startup stage debug prints to stderr in multiple startup paths |
| `ARCANE_PACKAGE_DIR` | Overrides package asset base dir resolution (docs/examples/changelog path lookup) |
| `ARCANE_DISABLE_LSPMUX` | If `1`, disables lspmux detection/integration and forces direct LSP server spawning |
| `OLLAMA_BASE_URL` | Default implicit Ollama discovery base URL override (`http://127.0.0.1:11434` if unset) |
| `ARCANE_EDIT_VARIANT` | If `hashline`, forces hashline read/grep display mode when edit tool available |
| `ARCANE_NO_PTY` | If `1`, disables interactive PTY path for bash tool |

`ARCANE_NO_PTY` is also set internally when CLI `--no-pty` is used.

---

## 6) Storage and config root paths

These are consumed via `@nghyane/arcane-utils/dirs` and affect where coding-agent stores data.

| Variable | Default / behavior |
|---|---|
| `ARCANE_CONFIG_DIR` | Config root dirname under home (default `.arcane`) |
| `ARCANE_CODING_AGENT_DIR` | Full override for agent directory (default `~/<ARCANE_CONFIG_DIR or .arcane>/agent`) |
| `PWD` | Used when matching canonical current working directory in path helpers |

---

## 7) Shell/tool execution environment

(From `packages/utils/src/procmgr.ts` and coding-agent bash tool integration.)

| Variable | Behavior |
|---|---|
| `ARCANE_BASH_NO_CI` | Suppresses automatic `CI=true` injection into spawned shell env |
| `CLAUDE_BASH_NO_CI` | Legacy alias fallback for `ARCANE_BASH_NO_CI` |
| `ARCANE_BASH_NO_LOGIN` | Intended to disable login shell mode |
| `CLAUDE_BASH_NO_LOGIN` | Legacy alias fallback for `ARCANE_BASH_NO_LOGIN` |
| `ARCANE_SHELL_PREFIX` | Optional command prefix wrapper |
| `CLAUDE_CODE_SHELL_PREFIX` | Legacy alias fallback for `ARCANE_SHELL_PREFIX` |
| `VISUAL` | Preferred external editor command |
| `EDITOR` | Fallback external editor command |

Current implementation note: `ARCANE_BASH_NO_LOGIN`/`CLAUDE_BASH_NO_LOGIN` are read, but current `getShellArgs()` returns `['-l','-c']` in both branches (effectively no-op today).

---

## 8) UI/theme/session detection (auto-detected env)

These are read as runtime signals; they are usually set by the terminal/OS rather than manually configured.

| Variable | Used for |
|---|---|
| `COLORTERM`, `TERM`, `WT_SESSION` | Color capability detection (theme color mode) |
| `COLORFGBG` | Terminal background light/dark auto-detection |
| `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMINAL_EMULATOR` | Terminal identity in system promptt/context |
| `KDE_FULL_SESSION`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `XDG_SESSION_DESKTOP`, `GDMSESSION`, `WINDOWMANAGER` | Desktop/window-manager detection in system promptt/context |
| `KITTY_WINDOW_ID`, `TMUX_PANE`, `TERM_SESSION_ID`, `WT_SESSION` | Stable per-terminal session breadcrumb IDs |
| `SHELL`, `ComSpec`, `TERM_PROGRAM`, `TERM` | System info diagnostics |
| `APPDATA`, `XDG_CONFIG_HOME` | lspmux config path resolution |
| `HOME` | Path shortening in MCP command UI |

---

## 9) Native loader/debug flags

| Variable | Behavior |
|---|---|
| `ARCANE_DEV` | Enables verbose native addon load diagnostics in `packages/natives` |

## 10) TUI runtime flags (shared package, affects coding-agent UX)

| Variable | Behavior |
|---|---|
| `ARCANE_NOTIFICATIONS` | `off` / `0` / `false` suppress desktop notifications |
| `ARCANE_TUI_WRITE_LOG` | If set, logs TUI writes to file |
| `ARCANE_HARDWARE_CURSOR` | If `1`, enables hardware cursor mode |
| `ARCANE_CLEAR_ON_SHRINK` | If `1`, clears empty rows when content shrinks |
| `ARCANE_DEBUG_REDRAW` | If `1`, enables redraw debug logging |
| `ARCANE_TUI_DEBUG` | If `1`, enables deep TUI debug dump path |

---

## 11) Commit generation controls

| Variable | Behavior |
|---|---|
| `ARCANE_COMMIT_TEST_FALLBACK` | If `true` (case-insensitive), force commit fallback generation path |
| `ARCANE_COMMIT_NO_FALLBACK` | If `true`, disables fallback when agent returns no proposal |
| `ARCANE_COMMIT_MAP_REDUCE` | If `false`, disables map-reduce commit analysis path |
| `DEBUG` | If set, commit agent error stack traces are printed |

---

## Security-sensitive variables

Treat these as secrets; do not log or commit them:

- Provider/API keys and OAuth/bearer credentials (all `*_AARCANE_KEY`, `*_TOKEN`, OAuth access/refresh tokens)
- Cloud credentials (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS` path may expose service-account material)
- Search/provider auth vars (`EXA_AARCANE_KEY`, `BRAVE_AARCANE_KEY`, `PERPLEXITY_AARCANE_KEY`, Anthropic search keys)

Python runtime also explicitly strips many common key vars before spawning kernel subprocesses (`packages/coding-agent/src/ipy/runtime.ts`).
