import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@nghyane/arcane-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate": check after each tool call (default)
	 * - "wait": defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI Codex).
	 */
	sessionId?: string;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after each tool execution to check for user interruptions unless interruptMode is "wait".
	 * If messages are returned, remaining tool calls are skipped and
	 * these messages are added to the context before the next LLM call.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	/**
	 * Enable intent tracing for tool calls.
	 * When enabled, the harness injects a `_intent: string` field into tool schemas sent to the model,
	 * then strips `_intent` from arguments before executing tools.
	 */
}

export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" is only supported by OpenAI gpt-5.1-codex-max, gpt-5.2, gpt-5.2-codex, gpt-5.3, and gpt-5.3-codex models.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@nghyane/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

/** @intentional-any — TDetails default: variance erasure for heterogeneous tool arrays */
export interface AgentToolResult<T = any, TNormative extends TSchema = any> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details?: T;
	/** Normative input for the tool result */
	$normative?: Static<TNormative>;
}

// Callback for streaming tool execution updates
/** @intentional-any — same variance erasure as AgentToolResult */
export type AgentToolUpdateCallback<T = any, TNormative extends TSchema = any> = (
	partialResult: AgentToolResult<T, TNormative>,
) => void;

/** Options passed to renderResult */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/**
 * Context passed to tool execution.
 * Apps can extend via declaration merging.
 */
export interface AgentToolContext {
	// Empty by default - apps extend via declaration merging
	/** Emit an event to the agent's event stream (used by meta-tools like Code Mode) */
	emit?: (event: AgentEvent) => void;
}

/** @intentional-any — TDetails default: tools declare their own detail type */
export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;

// AgentTool extends Tool but adds the execute function
/** @intentional-any — TDetails default: TypeScript lacks existential types, any required for variance erasure */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown>
	extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool execution ignores abort signals (runs to completion) */
	nonAbortable?: boolean;
	/**
	 * Concurrency mode for tool scheduling when multiple calls are in one turn.
	 * - "shared": can run alongside other shared tools (default)
	 * - "exclusive": runs alone; other tools wait until it finishes
	 */
	concurrency?: "shared" | "exclusive";
	/** Merge call and result into single visual block (default: false) */
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in response flow (default: false) */
	inline?: boolean;
	/** Format args into 1-line preview for collapsed display */
	formatArgs?: (args: Static<TParameters>) => string;
	/** Extract display lines from result for default renderer */
	formatResult?: (result: AgentToolResult<TDetails, TParameters>) => string | string[];
	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	/** Optional custom rendering for tool call display (returns UI component) */
	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	/** Optional custom rendering for tool result display (returns UI component) */
	renderResult?: (
		result: AgentToolResult<TDetails, TParameters>,
		options: RenderResultOptions,
		theme: TTheme,
		args?: Static<TParameters>,
	) => unknown;

	/** Called when tool args are fully streamed. Returns tool-specific state (e.g. edit diff preview). */
	onArgsComplete?: (args: Static<TParameters>, cwd: string) => Promise<unknown>;

	/** Build tool-specific render context passed to renderCall/renderResult via options.renderContext. */
	buildRenderContext?: (info: {
		args: Static<TParameters>;
		result?: AgentToolResult<TDetails, TParameters>;
		toolState?: unknown;
		expanded: boolean;
		getTextOutput: () => string;
	}) => Record<string, unknown>;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			intent?: string;
			tool?: AgentTool;
			/** Set when this event is a sub-tool call inside a meta-tool (e.g. Code Mode) */
			parentToolCallId?: string;
			/** Set when the tool call is inside a step() in Code Mode */
			stepId?: string;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: AgentToolResult;
			parentToolCallId?: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult;
			isError?: boolean;
			parentToolCallId?: string;
	  }
	| { type: "execution_abort"; toolCallId: string; message: string }
	// Step lifecycle (code tool grouping)
	| { type: "step_start"; toolCallId: string; stepId: string; intent: string; parentStepId?: string }
	| { type: "step_end"; toolCallId: string; stepId: string; durationMs: number }
	| { type: "step_progress"; toolCallId: string; stepId: string; message: string };

/**
 * Known tool argument shapes, keyed by tool name.
 * Grep "ToolArgsMap" to find any tool's arg shape instantly.
 * Tools not listed here fall back to Record<string, unknown>.
 */
export interface ToolArgsMap {
	edit: {
		path: string;
		edits?: unknown[];
		old_text?: string;
		new_text?: string;
		diff?: string;
		rename?: string;
		delete?: boolean;
	};
	bash: { command: string; timeout?: number; cwd?: string };
	python: { code: string; timeout?: number };
	read: { path: string; offset?: number; limit?: number };
	write: { path: string; content: string };
	grep: { pattern: string; path?: string; glob?: string; type?: string };
	find: { pattern: string; hidden?: boolean; limit?: number };
	ask: { questions: unknown[] };
	fetch: { url: string; timeout?: number };
	github: { action: string; owner?: string; repo?: string; path?: string; ref?: string; number?: number };
	ssh: { command: string; host: string; timeout?: number };
	browser: { action: string; url?: string; selector?: string; text?: string; value?: string };
	notebook: { action: string; code?: string; kernel?: string };
	todo_write: { todos: Array<{ id?: string; content: string; status: string }> };
	code: { code: string };
	task: { id: string; description: string; assignment: string; context?: string; complexity?: string };
	search_code: { query: string; regexp?: boolean; language?: string; repo?: string; limit?: number };
	undo_edit: { path: string };
}

/**
 * Known tool result detail shapes.
 * Only tools whose details are accessed outside renderResult need entries.
 */
export interface ToolDetailsMap {
	code: { logs?: string[] };
	todo_write: { todos?: Array<{ id: string; content: string; status: "completed" | "in_progress" | "pending" }> };
}

/** Narrow event args to a known tool shape. One cast, contained here. */
export function toolArgs<T extends keyof ToolArgsMap>(_name: T, args: Record<string, unknown>): ToolArgsMap[T] {
	return args as ToolArgsMap[T];
}

/** Narrow event result details to a known tool shape. One cast, contained here. */
export function toolDetails<T extends keyof ToolDetailsMap>(
	_name: T,
	details: Record<string, unknown>,
): ToolDetailsMap[T] {
	return details as ToolDetailsMap[T];
}
