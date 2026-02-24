import type { AgentTool } from "@nghyane/arcane-agent";
import { createCodeTool } from "@nghyane/arcane-codemode";
import { $env, logger } from "@nghyane/arcane-utils";
import type { PromptTemplate } from "../config/prompt-templates";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import type { InternalUrlRouter } from "../internal-urls";
import { getPreludeDocs, warmPythonEnvironment } from "../ipy/executor";
import { checkPythonKernelAvailability } from "../ipy/kernel";
import { LspTool } from "../lsp";
import { EditTool } from "../patch";
import guidanceTemplate from "../prompts/codemode/guidance.md" with { type: "text" };
import type { ArtifactManager } from "../session/artifacts";
import { TaskTool } from "../task";
import type { AgentOutputManager } from "../task/output-manager";
import type { EventBus } from "../utils/event-bus";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { time } from "../utils/timings";
import { SearchTool } from "../web/search";
import { AskTool } from "./ask";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { CalculatorTool } from "./calculator";
import { exploreConfig } from "./explore";
import { FetchTool } from "./fetch";
import { FindTool } from "./find";
import { GitHubTool } from "./github";
import { GrepTool } from "./grep";
import { librarianConfig } from "./librarian";
import { NotebookTool } from "./notebook";
import { oracleConfig } from "./oracle";
import { wrapToolWithMetaNotice } from "./output-meta";
import { PythonTool } from "./python";
import { ReadTool } from "./read";
import { reviewerConfig } from "./reviewer-tool";
import { loadSshTool } from "./ssh";
import { SubagentTool } from "./subagent-tool";
import { TodoWriteTool } from "./todo-write";
import { UndoEditTool } from "./undo-edit";
import { WriteTool } from "./write";

// Exa MCP tools (22 tools)

export { exaTools } from "../exa";
export type {
	ExaRenderDetails,
	ExaSearchResponse,
	ExaSearchResult,
} from "../exa/types";
export {
	type FileDiagnosticsResult,
	type FileFormatResult,
	getLspStatus,
	type LspServerStatus,
	LspTool,
	type LspToolDetails,
	type LspWarmupOptions,
	type LspWarmupResult,
	warmupLspServers,
} from "../lsp";
export { EditTool, type EditToolDetails } from "../patch";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatBytes,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../session/streaming-output";
export { BUNDLED_AGENTS, TaskTool } from "../task";
export {
	companySearchTools,
	exaSearchTools,
	getSearchTools,
	type SearchProvider,
	type SearchResponse,
	SearchTool,
	type SearchToolsOptions,
	setPreferredSearchProvider,
	webSearchCodeContextTool,
	webSearchCompanyTool,
	webSearchCrawlTool,
	webSearchCustomTool,
	webSearchDeepTool,
	webSearchLinkedinTool,
} from "../web/search";
export { AskTool, type AskToolDetails } from "./ask";
export {
	BashTool,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
} from "./bash";
export { BrowserTool, type BrowserToolDetails } from "./browser";
export { CalculatorTool, type CalculatorToolDetails } from "./calculator";
export { exploreConfig } from "./explore";
export { FetchTool, type FetchToolDetails } from "./fetch";
export {
	type FindOperations,
	FindTool,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find";
export { setPreferredImageProvider } from "./gemini-image";
export { GitHubTool, type GitHubToolDetails } from "./github";
export { GrepTool, type GrepToolDetails, type GrepToolInput } from "./grep";
export { librarianConfig } from "./librarian";
export { NotebookTool, type NotebookToolDetails } from "./notebook";
export { oracleConfig } from "./oracle";
export {
	PythonTool,
	type PythonToolDetails,
	type PythonToolOptions,
} from "./python";
export { ReadTool, type ReadToolDetails, type ReadToolInput } from "./read";
export { reviewerConfig } from "./reviewer-tool";
export { loadSshTool, type SSHToolDetails, SshTool } from "./ssh";
export { type SubagentConfig, SubagentTool } from "./subagent-tool";
export {
	type TodoItem,
	TodoWriteTool,
	type TodoWriteToolDetails,
} from "./todo-write";
export { UndoEditTool, type UndoEditToolDetails } from "./undo-edit";
export { WriteTool, type WriteToolDetails, type WriteToolInput } from "./write";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

/** Forwarded context for spawning subagent processes */
export interface SubagentContext {
	authStorage?: import("../session/auth-storage").AuthStorage;
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	mcpManager?: import("../mcp/manager").MCPManager;
	getCompactContext?: () => string;
}

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Whether UI is available */
	hasUI: boolean;
	/** Skip Python kernel availability check and warmup */
	skipPythonPreflight?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded skills */
	skills?: Skill[];
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether the edit tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Whether this session is a subagent (spawned by task tool) */
	isSubagent?: boolean;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Cached artifact manager (allocated per ToolSession) */
	artifactManager?: ArtifactManager;
	/** Get artifacts directory for artifact:// URLs and $ARTIFACTS env var */
	getArtifactsDir?: () => string | null;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Context for spawning subagent processes (only used by task/subagent tools) */
	subagentContext?: SubagentContext;
	/** Internal URL router for agent:// and skill:// URLs */
	internalRouter?: InternalUrlRouter;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/** Settings instance for passing to subagents */
	settings: Settings;
}

type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export const BUILTIN_TOOLS: Record<string, ToolFactory> = {
	ask: AskTool.createIf,
	bash: s => new BashTool(s),
	python: s => new PythonTool(s),
	calc: () => new CalculatorTool(),
	ssh: loadSshTool,
	edit: s => new EditTool(s),
	find: s => new FindTool(s),
	explore: s => new SubagentTool(s, exploreConfig),
	github: s => new GitHubTool(s),
	grep: s => new GrepTool(s),
	librarian: s => new SubagentTool(s, librarianConfig),
	lsp: LspTool.createIf,
	notebook: s => new NotebookTool(s),
	oracle: s => new SubagentTool(s, oracleConfig),
	read: s => new ReadTool(s),
	browser: s => new BrowserTool(s),
	task: TaskTool.create,
	code_review: s => new SubagentTool(s, reviewerConfig),
	todo_write: s => new TodoWriteTool(s),
	undo_edit: s => new UndoEditTool(s),
	fetch: s => new FetchTool(s),
	web_search: () => new SearchTool(),
	write: s => new WriteTool(s),
};

export type ToolName = keyof typeof BUILTIN_TOOLS;

export type PythonToolMode = "ipy-only" | "bash-only" | "both";

/**
 * Parse ARCANE_PY environment variable to determine Python tool mode.
 * Returns null if not set or invalid.
 *
 * Values:
 * - "0" or "bash" → bash-only
 * - "1" or "py" → ipy-only
 * - "mix" or "both" → both
 */
function getPythonModeFromEnv(): PythonToolMode | null {
	const value = $env.ARCANE_PY?.toLowerCase();
	if (!value) return null;

	switch (value) {
		case "0":
		case "bash":
			return "bash-only";
		case "1":
		case "py":
			return "ipy-only";
		case "mix":
		case "both":
			return "both";
		default:
			return null;
	}
}

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	time("createTools:start");
	const enableLsp = session.enableLsp ?? true;
	const requestedTools = toolNames && toolNames.length > 0 ? [...new Set(toolNames)] : undefined;
	const pythonMode = getPythonModeFromEnv() ?? session.settings.get("python.toolMode");
	const skipPythonPreflight = session.skipPythonPreflight === true;
	let pythonAvailable = true;
	const shouldCheckPython =
		!skipPythonPreflight &&
		pythonMode !== "bash-only" &&
		(requestedTools === undefined || requestedTools.includes("python"));
	const isTestEnv = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	const skipPythonWarm = isTestEnv || $env.ARCANE_PYTHON_SKIP_CHECK === "1";
	if (shouldCheckPython) {
		const availability = await checkPythonKernelAvailability(session.cwd);
		time("createTools:pythonCheck");
		pythonAvailable = availability.ok;
		if (!availability.ok) {
			logger.warn("Python kernel unavailable, falling back to bash", {
				reason: availability.reason,
			});
		} else if (!skipPythonWarm && getPreludeDocs().length === 0) {
			const sessionFile = session.getSessionFile?.() ?? undefined;
			const warmSessionId = sessionFile ? `session:${sessionFile}:cwd:${session.cwd}` : `cwd:${session.cwd}`;
			try {
				await warmPythonEnvironment(session.cwd, warmSessionId, session.settings.get("python.sharedGateway"));
				time("createTools:warmPython");
			} catch (err) {
				logger.warn("Failed to warm Python environment", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	const effectiveMode = pythonAvailable ? pythonMode : "bash-only";
	const allowBash = effectiveMode !== "ipy-only";
	const allowPython = effectiveMode !== "bash-only";
	if (
		requestedTools &&
		allowBash &&
		!allowPython &&
		requestedTools.includes("python") &&
		!requestedTools.includes("bash")
	) {
		requestedTools.push("bash");
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name === "lsp") return enableLsp;
		if (name === "bash") return allowBash;
		if (name === "python") return allowPython;
		if (name === "todo_write") return session.settings.get("todo.enabled");
		if (name === "find") return session.settings.get("find.enabled");
		if (name === "grep") return session.settings.get("grep.enabled");
		if (name === "notebook") return session.settings.get("notebook.enabled");
		if (name === "fetch") return session.settings.get("fetch.enabled");
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "lsp") return session.settings.get("lsp.enabled");
		if (name === "calc") return session.settings.get("calc.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "librarian") return session.settings.get("librarian.enabled");
		if (name === "oracle") return session.settings.get("oracle.enabled");
		if (name === "github") return session.settings.get("github.enabled");
		if (name === "task") {
			return !session.isSubagent;
		}
		return true;
	};

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));

	const entries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.map(name => [name, allTools[name]] as const)
			: [...Object.entries(BUILTIN_TOOLS).filter(([name]) => isToolAllowed(name))];

	const results = await Promise.all(
		entries.map(async ([name, factory]) => {
			if (filteredRequestedTools && !filteredRequestedTools.includes(name)) {
				return null;
			}
			const tool = await factory(session);
			time(`createTools:${name}`);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	const tools = results.filter((r): r is Tool => r !== null);

	// Code Mode: wrap all eligible tools into a single "code" tool
	const displayMode = resolveFileDisplayMode(session);
	const guidance = renderPromptTemplate(guidanceTemplate, {
		IS_HASHLINE_MODE: displayMode.hashLines,
		IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
	});
	const { codeTool, excludedTools } = createCodeTool(tools, { guidance });
	return [codeTool as Tool, ...(excludedTools as Tool[])];
}
