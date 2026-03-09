/**
 * In-process subagent executor.
 *
 * Manages agent lifecycle (session creation, abort handling, cleanup) and
 * forwards AgentEvents to an EventBus. All observation (progress tracking,
 * output extraction, usage accumulation) is the caller's responsibility
 * via EventBus subscriptions.
 */
import * as path from "node:path";
import type { AgentEvent, ThinkingLevel } from "@nghyane/arcane-agent";
import { logger, untilAborted } from "@nghyane/arcane-utils";
import type { TSchema } from "@sinclair/typebox";
import { ModelRegistry } from "../config/model-registry";
import { resolveModelOverride } from "../config/model-resolver";
import { type PromptTemplate, renderPromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { Skill } from "../extensibility/skills";
import { callTool } from "../mcp/client";
import type { MCPManager } from "../mcp/manager";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import type { ContextFileEntry } from "../tools";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { type AgentDefinition, type SingleResult, TASK_SUBAGENT_EVENT_CHANNEL } from "./types";

const MCP_CALL_TIMEOUT_MS = 60_000;

/** Agent event types worth forwarding. */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

function withAbortTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		settled = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	agent: AgentDefinition;
	task: string;
	description?: string;
	index: number;
	id: string;
	modelOverride?: string | string[];
	thinkingLevel?: ThinkingLevel;
	isSubagent?: boolean;
	enableLsp?: boolean;
	signal?: AbortSignal;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	/** Path to parent conversation context file */
	contextFile?: string;
	/** EventBus for forwarding agent events. Required — all observation happens here. */
	eventBus: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	preloadedSkills?: Skill[];
	promptTemplates?: PromptTemplate[];
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
}

/**
 * Create proxy tools that reuse the parent's MCP connections.
 */
function createMCPProxyTools(mcpManager: MCPManager): CustomTool<TSchema>[] {
	return mcpManager.getTools().map(tool => {
		const mcpTool = tool as { mcpToolName?: string; mcpServerName?: string };
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters as TSchema,
			execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
				if (signal?.aborted) throw new ToolAbortError();
				const serverName = mcpTool.mcpServerName ?? "";
				const mcpToolName = mcpTool.mcpToolName ?? "";
				try {
					const result = await withAbortTimeout(
						(async () => {
							const connection = await mcpManager.waitForConnection(serverName);
							return callTool(connection, mcpToolName, params as Record<string, unknown>, { signal });
						})(),
						MCP_CALL_TIMEOUT_MS,
						signal,
					);
					return {
						content: (result.content ?? []).map(item =>
							item.type === "text"
								? { type: "text" as const, text: item.text ?? "" }
								: { type: "text" as const, text: JSON.stringify(item) },
						),
						details: { serverName, mcpToolName, isError: result.isError },
					};
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `MCP error: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { serverName, mcpToolName, isError: true },
					};
				}
			},
		};
	});
}

/**
 * Run a single agent in-process.
 *
 * Forwards all AgentEvents to options.eventBus. Callers observe progress,
 * usage, and output by subscribing to the bus before calling this function.
 */
export async function runAgent(options: ExecutorOptions): Promise<SingleResult> {
	const { cwd, agent, task, index, id, modelOverride, thinkingLevel, enableLsp, signal, eventBus } = options;
	const startTime = Date.now();

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			task,
			description: options.description,
			exitCode: 1,
			stderr: "Aborted before start",
			durationMs: 0,
			tokens: 0,
			error: "Aborted",
		};
	}

	// Set up artifact paths
	let subtaskSessionFile: string | undefined;
	if (options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();
	// Sub-agents never get the task tool — no recursive nesting
	let toolNames = agent.tools.filter(name => name !== "task");
	const pythonToolMode = settings.get("python.toolMode") ?? "both";
	if (toolNames.includes("exec")) {
		const expanded = toolNames.filter(name => name !== "exec");
		if (pythonToolMode === "bash-only") {
			expanded.push("bash");
		} else if (pythonToolMode === "ipy-only") {
			expanded.push("python");
		} else {
			expanded.push("python", "bash");
		}
		toolNames = Array.from(new Set(expanded));
	}

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const lspEnabled = enableLsp ?? true;
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("python");

	let stderr = "";
	let resolved = false;
	type AbortReason = "signal" | "terminate";
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let unsubscribe: (() => void) | null = null;

	const requestAbort = (reason: AbortReason) => {
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		if (activeSession) {
			void activeSession.abort();
		}
	};

	/** Allow external observers (e.g. ProgressTracker) to request termination. */
	const terminateListener = eventBus.on("executor:terminate", () => {
		requestAbort("terminate");
	});

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) requestAbort("signal");
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true, signal: listenerSignal });
	}

	// Forward agent events to EventBus — the only thing processEvent does
	const processEvent = (event: AgentEvent) => {
		if (resolved) return;
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index,
			agent: agent.name,
			task,
			event,
		});
	};

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		durationMs: number;
	}> => {
		const sessionAbortController = new AbortController();
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;

		const checkAbort = () => {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				exitCode = 1;
				throw new ToolAbortError();
			}
		};

		try {
			checkAbort();
			const authStorage = options.authStorage ?? (await discoverAuthStorage());
			checkAbort();
			const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
			// Skip refresh when reusing parent's registry — models are already discovered
			if (!options.modelRegistry) {
				await modelRegistry.refresh();
			}
			checkAbort();

			const { model, thinkingLevel: resolvedThinkingLevel } = resolveModelOverride(
				modelPatterns,
				modelRegistry,
				settings,
			);
			const effectiveThinkingLevel = thinkingLevel ?? resolvedThinkingLevel;

			const sessionManager = sessionFile ? await SessionManager.open(sessionFile) : SessionManager.inMemory(cwd);

			const mcpProxyTools = options.mcpManager ? createMCPProxyTools(options.mcpManager) : [];
			const enableMCP = !options.mcpManager;

			const { session } = await createAgentSession({
				cwd,
				authStorage,
				modelRegistry,
				settings,
				model,
				thinkingLevel: effectiveThinkingLevel,
				toolNames,
				contextFiles: options.contextFiles,
				skills: options.skills,
				preloadedSkills: options.preloadedSkills,
				promptTemplates: options.promptTemplates,
				systemPrompt: defaultPrompt =>
					renderPromptTemplate(subagentSystemPromptTemplate, {
						base: defaultPrompt,
						agent: agent.systemPrompt,
						contextFile: options.contextFile,
					}),
				sessionManager,
				hasUI: false,
				isSubagent: true,
				parentTaskPrefix: id,
				enableLsp: lspEnabled,
				skipPythonPreflight,
				enableMCP,
				customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
				disableExtensionDiscovery: true,
			});

			activeSession = session;

			const subagentToolNames = session.getActiveToolNames();
			const parentOwnedToolNames = new Set(["todo_write"]);
			const filteredSubagentTools = subagentToolNames.filter(name => !parentOwnedToolNames.has(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await session.setActiveToolsByName(filteredSubagentTools);
			}

			session.sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt,
				task,
				tools: session.getActiveToolNames(),
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void session.abort();
				},
				{ once: true, signal: sessionAbortController.signal },
			);

			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				extensionRunner.initialize(
					{
						sendMessage: (message, msgOptions) => {
							session.sendCustomMessage(message, msgOptions).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
						},
						sendUserMessage: (content, msgOptions) => {
							session.sendUserMessage(content, msgOptions).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						setActiveTools: (names: string[]) =>
							session.setActiveToolsByName(names.filter(name => !parentOwnedToolNames.has(name))),
						getCommands: () => [],
						setModel: async modelStr => {
							const key = await session.modelRegistry.getApiKey(modelStr);
							if (!key) return false;
							await session.setModel(modelStr);
							return true;
						},
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: level => session.setThinkingLevel(level),
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						abort: () => session.abort(),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
					},
				);
				await extensionRunner.emit({ type: "session_start" });
			}

			unsubscribe = session.subscribe(event => {
				if (isAgentEvent(event)) {
					try {
						processEvent(event);
					} catch (err) {
						logger.error("Subagent event processing failed", {
							error: err instanceof Error ? err.message : String(err),
						});
						requestAbort("terminate");
					}
				}
			});

			await session.prompt(task);

			const lastMessage = session.state.messages[session.state.messages.length - 1];
			if (lastMessage?.role === "assistant") {
				if (lastMessage.stopReason === "aborted") {
					aborted = abortReason === "signal" || abortReason === undefined;
					exitCode = 1;
				} else if (lastMessage.stopReason === "error") {
					exitCode = 1;
					error ??= lastMessage.errorMessage || "Subagent failed";
				}
			}
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			if (activeSession) {
				const session = activeSession;
				activeSession = null;
				try {
					await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
				} catch {
					// Ignore cleanup errors
				}
			}
		}

		return {
			exitCode,
			error,
			aborted,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	resolved = true;
	listenerController.abort();
	terminateListener();

	if (done.error) {
		stderr = done.error;
	}

	const wasAborted = done.aborted || signal?.aborted || false;

	return {
		index,
		id,
		agent: agent.name,
		task,
		description: options.description,
		exitCode: done.exitCode,
		stderr,
		durationMs: Date.now() - startTime,
		tokens: 0,
		error: done.exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
	};
}
