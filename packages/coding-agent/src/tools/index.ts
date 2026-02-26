import type { AgentTool } from "@nghyane/arcane-agent";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import type { InternalUrlRouter } from "../internal-urls";
import type { ArtifactManager } from "../session/artifacts";
import type { AgentOutputManager } from "../task/output-manager";
import type { EventBus } from "../utils/event-bus";

// Exa MCP tools (22 tools)

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

export { BUILTIN_TOOLS, createTools, type ToolName } from "./create-tools";
