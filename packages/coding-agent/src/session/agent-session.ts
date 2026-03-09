/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as fs from "node:fs";

import {
	type Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type ThinkingLevel,
} from "@nghyane/arcane-agent";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	TextContent,
	ToolChoice,
	UsageReport,
} from "@nghyane/arcane-ai";
import { isContextOverflow } from "@nghyane/arcane-ai";
import { abortableSleep, isEnoent, logger } from "@nghyane/arcane-utils";
import { getAgentDbPath } from "@nghyane/arcane-utils/dirs";
import type { ModelRegistry, ModelRole } from "../config/model-registry";
import {
	expandPromptTemplate,
	type PromptTemplate,
	parseCommandArgs,
	renderPromptTemplate,
} from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { executePython as executePythonCommand, type PythonResult } from "../ipy/executor";
import verificationReminderTemplate from "../prompts/system/verification-reminder.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import { closeAllConnections } from "../ssh/connection-manager";
import { unmountAll } from "../ssh/sshfs-mount";
import { theme } from "../theme/theme";
import { outputMeta } from "../tools/output-meta";
import type { TodoItem } from "../tools/todo-write";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction";
import type { BashExecutionMessage, CustomMessage, PythonExecutionMessage } from "./messages";
import { ModelController } from "./model-controller";
import { isRetryableErrorMessage, isUsageLimitErrorMessage, parseRetryAfterMs } from "./retry-utils";
import type { BranchSummaryEntry, NewSessionOptions, SessionManager } from "./session-manager";
import type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	HandoffResult,
	ModelCycleResult,
	PromptOptions,
	RoleModelCycleResult,
	SessionStats,
} from "./session-types";
import * as sessionStats from "./stats";
import {
	createStreamingEditState,
	invalidateFileCacheForPath,
	maybeAbortStreamingEdit,
	preCacheStreamingEditFile,
	resetStreamingEditState,
} from "./streaming-edit";
import {
	addPendingTtsrInjections,
	createTtsrState,
	extractTtsrRuleNames,
	findTtsrAssistantIndex,
	getTtsrInjectionContent,
	getTtsrToolMatchContext,
	markTtsrInjected,
	queueDeferredTtsrInjectionIfNeeded,
	shouldInterruptForTtsrMatch,
} from "./ttsr";

// Re-export types for downstream consumers
export type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	HandoffResult,
	ModelCycleResult,
	PromptOptions,
	RoleModelCycleResult,
	SessionStats,
};

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;

	#model: ModelController;
	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#eventListeners: AgentSessionEventListener[] = [];

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	#steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	#followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;

	// Handoff state
	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;

	// Retry state
	#retryAbortController: AbortController | undefined = undefined;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined = undefined;
	#retryResolve: (() => void) | undefined = undefined;

	// Todo completion reminder state
	#todoReminderCount = 0;

	// Auto-handoff state
	#contextWarningEmitted = false;
	// Verification loop state
	#verificationReminderCount = 0;
	#turnHasFileModifications = false;
	#editErrorSteerCount = 0;

	// Bash execution state
	#bashAbortController: AbortController | undefined = undefined;
	#pendingBashMessages: BashExecutionMessage[] = [];

	// Python execution state
	#pythonAbortController: AbortController | undefined = undefined;
	#pendingPythonMessages: PythonExecutionMessage[] = [];

	// Extension system
	#extensionRunner: ExtensionRunner | undefined = undefined;
	#turnIndex = 0;

	#skills: Skill[];
	#skillWarnings: SkillWarning[];

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];

	#skillsSettings: Required<SkillsSettings> | undefined;

	// Tool registry and prompt builder for extensions
	#toolRegistry: Map<string, AgentTool>;
	#rebuildSystemPrompt: ((toolNames: string[], tools: Map<string, AgentTool>) => Promise<string>) | undefined;
	#baseSystemPrompt: string;

	// TTSR manager for time-traveling stream rules
	#ttsrManager: TtsrManager | undefined = undefined;
	#ttsr = createTtsrState();

	#streamingEdit = createStreamingEditState();
	#promptInFlight = false;
	#obfuscator: SecretObfuscator | undefined;
	#promptGeneration = 0;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#model = new ModelController(config.agent, config.settings, config.sessionManager, config.modelRegistry, {
			scopedModels: config.scopedModels,
			forceCopilotAgentInitiator: config.forceCopilotAgentInitiator,
		});
		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#skills = config.skills ?? [];
		this.#skillWarnings = config.skillWarnings ?? [];
		this.#customCommands = config.customCommands ?? [];
		this.#skillsSettings = config.skillsSettings;
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#rebuildSystemPrompt = config.rebuildSystemPrompt;
		this.#baseSystemPrompt = this.agent.state.systemPrompt;
		this.#ttsrManager = config.ttsrManager;
		this.#obfuscator = config.obfuscator;
		this.agent.providerSessionState = this.#model.providerSessionState;

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#model.registry;
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#model.providerSessionState;
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsrManager;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsr.abortPending;
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			l(event);
		}
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		await this.#emitExtensionEvent(event);
		this.#emit(event);
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = this.#getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this.#steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this.#steeringMessages.splice(steeringIndex, 1);
				} else {
					// Check follow-up queue
					const followUpIndex = this.#followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this.#followUpMessages.splice(followUpIndex, 1);
					}
				}
			}
		}

		await this.#emitSessionEvent(event);

		if (event.type === "turn_start") {
			resetStreamingEditState(this.#streamingEdit);
			// TTSR: Reset buffer on turn start
			this.#ttsrManager?.resetBuffer();
		}

		// TTSR: Increment message count on turn end (for repeat-after-gap tracking)
		if (event.type === "turn_end" && this.#ttsrManager) {
			this.#ttsrManager.incrementMessageCount();
		}

		// TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
		if (event.type === "message_update" && this.#ttsrManager?.hasRules()) {
			const assistantEvent = event.assistantMessageEvent;
			let matchContext: TtsrMatchContext | undefined;

			if (assistantEvent.type === "text_delta") {
				matchContext = { source: "text" };
			} else if (assistantEvent.type === "thinking_delta") {
				matchContext = { source: "thinking" };
			} else if (assistantEvent.type === "toolcall_delta") {
				matchContext = getTtsrToolMatchContext(
					event.message,
					assistantEvent.contentIndex,
					this.sessionManager.getCwd(),
				);
			}

			if (matchContext && "delta" in assistantEvent) {
				const matches = this.#ttsrManager.checkDelta(assistantEvent.delta, matchContext);
				if (matches.length > 0) {
					// Queue rules for injection; mark as injected only after successful enqueue.

					addPendingTtsrInjections(this.#ttsr, matches);

					if (shouldInterruptForTtsrMatch(this.#ttsrManager, matchContext)) {
						// Abort the stream immediately — do not gate on extension callbacks
						this.#ttsr.abortPending = true;
						this.agent.abort();
						// Notify extensions (fire-and-forget, does not block abort)
						this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
						// Schedule retry after a short delay
						const retryToken = ++this.#ttsr.retryToken;
						const generation = this.#promptGeneration;
						const targetMessageTimestamp =
							event.message.role === "assistant" ? event.message.timestamp : undefined;
						setTimeout(async () => {
							if (this.#ttsr.retryToken !== retryToken) {
								return;
							}

							const targetAssistantIndex = findTtsrAssistantIndex(
								this.agent.state.messages,
								targetMessageTimestamp,
							);
							if (
								!this.#ttsr.abortPending ||
								this.#promptGeneration !== generation ||
								targetAssistantIndex === -1
							) {
								this.#ttsr.abortPending = false;
								this.#ttsr.pendingInjections = [];
								return;
							}
							this.#ttsr.abortPending = false;
							const ttsrSettings = this.#ttsrManager?.getSettings();
							if (ttsrSettings?.contextMode === "discard") {
								// Remove the partial/aborted assistant turn from agent state
								this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
							}
							// Inject TTSR rules as system reminder before retry
							const injection = getTtsrInjectionContent(this.#ttsr);
							if (injection) {
								const details = { rules: injection.rules.map(rule => rule.name) };
								this.agent.appendMessage({
									role: "custom",
									customType: "ttsr-injection",
									content: injection.content,
									display: false,
									details,
									timestamp: Date.now(),
								});
								this.sessionManager.appendCustomMessageEntry(
									"ttsr-injection",
									injection.content,
									false,
									details,
								);
								markTtsrInjected(this.#ttsrManager, this.sessionManager, details.rules);
							}
							this.agent.continue().catch(() => {});
						}, 50);
						return;
					}
				}
			}
		}

		if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") {
			preCacheStreamingEditFile(event, this.#streamingEdit, this.settings, this.sessionManager.getCwd());
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			maybeAbortStreamingEdit(
				event,
				this.#streamingEdit,
				this.settings,
				this.agent,
				this.sessionManager.getCwd(),
				this.#obfuscator,
			);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a hook/custom message
			if (event.message.role === "hookMessage" || event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
				if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
					markTtsrInjected(this.#ttsrManager, this.sessionManager, extractTtsrRuleNames(event.message.details));
				}
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult" ||
				event.message.role === "fileMention"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, branchSummary) are persisted elsewhere

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				queueDeferredTtsrInjectionIfNeeded(this.#ttsr, this.agent, assistantMsg);
				if (this.#handoffAbortController) {
					this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				if (
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					this.#retryAttempt > 0
				) {
					await this.#emitSessionEvent({
						type: "auto_retry_end",
						success: true,
						attempt: this.#retryAttempt,
					});
					this.#retryAttempt = 0;
					this.#resolveRetry();
				}
			}

			if (event.message.role === "toolResult") {
				const { toolName, details, isError, content } = event.message as {
					toolName?: string;
					details?: { path?: string };
					isError?: boolean;
					content?: Array<TextContent | ImageContent>;
				};
				// Invalidate streaming edit cache when edit tool completes to prevent stale data
				if (toolName === "edit" && details?.path) {
					invalidateFileCacheForPath(this.#streamingEdit, details.path, this.sessionManager.getCwd());
				}
				// Track file modifications for auto-verification
				if ((toolName === "edit" || toolName === "write") && !isError) {
					this.#turnHasFileModifications = true;
				}
				if (toolName === "todo_write" && isError) {
					const errorText = content?.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system_reminder>",
						"todo_write failed, so todo progress is not visible to the user.",
						errorText ? `Failure: ${errorText}` : "Failure: todo_write returned an error.",
						"Fix the todo payload and call todo_write again before continuing.",
						"</system_reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-write-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (toolName === "edit" && isError && this.#editErrorSteerCount < 2) {
					this.#editErrorSteerCount++;
					const errorText = content?.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system_reminder>",
						"The edit tool failed. Re-read the file to get fresh line tags, then retry the edit.",
						errorText ? `Failure: ${errorText}` : "Failure: edit returned an error.",
						"</system_reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "edit-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "steer" },
					);
				}
			}
		}

		// Check auto-retry after agent completes
		if (event.type === "agent_end") {
			const msg = this.#findLastAssistantMessage();
			if (!msg) return;

			if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
				return;
			}

			// Check for auto-handoff (context overflow or high usage)
			const didHandoff = await this.#checkAutoHandoff(msg);
			if (didHandoff) return;

			// Check for retryable errors first (overloaded, rate limit, server errors)
			if (this.#isRetryableError(msg)) {
				const didRetry = await this.#handleRetryableError(msg);
				if (didRetry) return;
			}

			// Check verification (if agent modified files without verifying)
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
				const didRemind = await this.#checkVerification();
				if (didRemind) return;
			}

			// Check for incomplete todos (unless there was an error or abort)
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
				await this.#checkTodoCompletion();
			}
		}
	};

	/** Resolve the pending retry promise */
	#resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}
	/** Extract text content from a message */
	#getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter(c => c.type === "text");
		const text = textBlocks.map(c => (c as TextContent).text).join("");
		if (text.length > 0) return text;
		const hasImages = content.some(c => c.type === "image");
		return hasImages ? "[Image]" : "";
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this.#extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		await this.sessionManager.flush();
		await cleanupSshResources();
		for (const state of this.#model.providerSessionState.values()) {
			state.close();
		}
		this.#model.providerSessionState.clear();
		this.#disconnectFromAgent();
		this.#eventListeners = [];
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}
	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlight;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this.#toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.setTools(tools);

		// Rebuild base system prompt with new tool set
		if (this.#rebuildSystemPrompt) {
			this.#baseSystemPrompt = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry);
			this.agent.setSystemPrompt(this.#baseSystemPrompt);
		}
	}

	/** Rebuild the base system prompt using the current active tool set. */
	async refreshBaseSystemPrompt(): Promise<void> {
		if (!this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		this.#baseSystemPrompt = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry);
		this.agent.setSystemPrompt(this.#baseSystemPrompt);
	}

	/**
	 * Replace MCP tools in the registry and activate the latest MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 */
	async refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const prefix = "mcp_";
		const existingNames = Array.from(this.#toolRegistry.keys());
		for (const name of existingNames) {
			if (name.startsWith(prefix)) {
				this.#toolRegistry.delete(name);
			}
		}

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.sessionManager,
			modelRegistry: this.#model.registry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
		});

		for (const customTool of mcpTools) {
			const wrapped = CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool;
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
		}

		const currentActive = this.getActiveToolNames().filter(
			name => !name.startsWith(prefix) && this.#toolRegistry.has(name),
		);
		const mcpToolNames = Array.from(this.#toolRegistry.keys()).filter(name => name.startsWith(prefix));
		const nextActive = [...currentActive];
		for (const name of mcpToolNames) {
			if (!nextActive.includes(name)) {
				nextActive.push(name);
			}
		}

		await this.setActiveToolsByName(nextActive);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel: ThinkingLevel }> {
		return this.#model.scopedModels;
	}

	resolveRoleModel(role: ModelRole): Model | undefined {
		return this.#model.resolveRoleModel(role);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#customCommands;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueFollowUp(expandedText, options?.images);
			} else {
				await this.#queueSteer(expandedText, options?.images);
			}
			return;
		}

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (options?.images) {
			userContent.push(...options.images);
		}

		await this.#promptWithMessage(
			{
				role: "user",
				content: userContent,
				synthetic: options?.synthetic,
				timestamp: Date.now(),
			},
			expandedText,
			options,
		);
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice">,
	): Promise<void> {
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			await this.sendCustomMessage(message, { deliverAs: options.streamingBehavior });
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, options);
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images">,
	): Promise<void> {
		this.#promptInFlight = true;
		const generation = this.#promptGeneration;
		try {
			// Flush any pending bash messages before the new prompt
			this.#flushPendingBashMessages();
			this.#flushPendingPythonMessages();

			// Reset todo reminder count on new user prompt
			this.#todoReminderCount = 0;
			this.#verificationReminderCount = 0;
			this.#turnHasFileModifications = false;
			this.#editErrorSteerCount = 0;

			// Validate model
			if (!this.model) {
				throw new Error(
					"No model selected.\n\n" +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
						"Then use /model to select a model.",
				);
			}

			// Validate API key
			const apiKey = await this.#model.registry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				throw new Error(
					`No API key found for ${this.model.provider}.\n\n` +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
				);
			}

			// Build messages array (custom messages if any, then user message)
			const messages: AgentMessage[] = [];

			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
				});
				messages.push(...fileMentionMessages);
			}

			// Emit before_agent_start extension event
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					this.#baseSystemPrompt,
				);
				if (result?.messages) {
					for (const msg of result.messages) {
						messages.push({
							role: "custom",
							customType: msg.customType,
							content: msg.content,
							display: msg.display,
							details: msg.details,
							timestamp: Date.now(),
						});
					}
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(this.#baseSystemPrompt);
				}
			}

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			await this.#promptAgentWithIdleRetry(messages, agentPromptOptions);
			await this.#waitForRetry();
		} finally {
			this.#promptInFlight = false;
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#model.registry,
			model: this.model ?? undefined,
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				void this.dispose();
				process.exit(0);
			},
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.agent.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
		};
	}

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0) return null;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// Find matching command
		const loaded = this.#customCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			return result ?? "";
		} catch (err) {
			// Emit error via extension runner
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: err instanceof Error ? err.message : String(err),
				});
			} else {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	async #queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#steeringMessages.push(displayText);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	async #queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#followUpMessages.push(displayText);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		};
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#pendingNextTurnMessages.push(appMessage);
				return;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
			return;
		}

		if (options?.triggerTurn) {
			await this.agent.prompt(appMessage);
			return;
		}

		this.agent.appendMessage(appMessage);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
		});
	}

	/**
	 * Clear queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this.#steeringMessages];
		const followUp = [...this.#followUpMessages];
		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.agent.clearAllQueues();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get queuedMessageCount(): number {
		return this.#steeringMessages.length + this.#followUpMessages.length;
	}

	/** Get pending messages (read-only) */
	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return { steering: this.#steeringMessages, followUp: this.#followUpMessages };
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 */
	popLastQueuedMessage(): string | undefined {
		// Pop from steering first (LIFO)
		if (this.#steeringMessages.length > 0) {
			const message = this.#steeringMessages.pop();
			this.agent.popLastSteer();
			return message;
		}
		// Then from follow-up
		if (this.#followUpMessages.length > 0) {
			const message = this.#followUpMessages.pop();
			this.agent.popLastFollowUp();
			return message;
		}
		return undefined;
	}

	get skillsSettings(): Required<SkillsSettings> | undefined {
		return this.#skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Skill loading warnings captured by SDK */
	get skillWarnings(): readonly SkillWarning[] {
		return this.#skillWarnings;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.#promptGeneration++;
		this.agent.abort();
		await this.agent.waitForIdle();
		// Clear promptInFlight: waitForIdle resolves when the agent loop's finally
		// block runs (#resolveRunningPrompt), but #promptWithMessage's finally
		// (#promptInFlight = false) fires on a later microtask. Without this,
		// isStreaming stays true and a subsequent prompt() throws.
		this.#promptInFlight = false;
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.agent.reset();
		await this.sessionManager.flush();
		await this.sessionManager.newSession(options);
		this.agent.sessionId = this.sessionManager.getSessionId();
		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.#pendingNextTurnMessages = [];

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);

		this.#todoReminderCount = 0;
		this.#reconnectToAgent();

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.setSessionName(name);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();

		// Fork the session (creates new session file with same entries)
		const forkResult = await this.sessionManager.fork();
		if (!forkResult) {
			return false;
		}

		// Copy artifacts directory if it exists
		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Update agent session ID
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	async setModel(model: Model, role: ModelRole = "default"): Promise<void> {
		return this.#model.setModel(model, role);
	}

	async setModelTemporary(model: Model): Promise<void> {
		return this.#model.setModelTemporary(model);
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this.#model.cycleModel(direction);
	}

	async cycleRoleModels(
		roleOrder: readonly ModelRole[],
		options?: { temporary?: boolean },
	): Promise<RoleModelCycleResult | undefined> {
		return this.#model.cycleRoleModels(roleOrder, options);
	}

	getAvailableModels(): Model[] {
		return this.#model.getAvailableModels();
	}

	setThinkingLevel(level: ThinkingLevel, persist = false): void {
		this.#model.setThinkingLevel(level, persist);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this.#model.cycleThinkingLevel();
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this.#model.getAvailableThinkingLevels();
	}

	supportsXhighThinking(): boolean {
		return this.#model.supportsXhighThinking();
	}

	supportsThinking(): boolean {
		return this.#model.supportsThinking();
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#handoffAbortController?.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document by asking the agent, then start a new session with it.
	 *
	 * This prompts the current agent to write a comprehensive handoff document,
	 * waits for completion, then starts a fresh session with the handoff as context.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	async handoff(customInstructions?: string): Promise<HandoffResult | undefined> {
		const entries = this.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;

		this.#handoffAbortController = new AbortController();

		// Build the handoff prompt
		let handoffPrompt = `Write a comprehensive handoff document that will allow another instance of yourself to seamlessly continue this work. The document should capture everything needed to resume without access to this conversation.

Use this format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- [Code snippets, file paths, error messages, or data essential to continue]
- [Repository state if relevant]

## Next Steps
1. [What should happen next]

Be thorough - include exact file paths, function names, error messages, and technical details. Output ONLY the handoff document, no other text.`;

		if (customInstructions) {
			handoffPrompt += `\n\nAdditional focus: ${customInstructions}`;
		}

		// Create a promise that resolves when the agent completes
		let handoffText: string | undefined;
		const { promise: completionPromise, resolve, reject } = Promise.withResolvers<void>();
		const unsubscribe = this.subscribe(event => {
			if (this.#handoffAbortController?.signal.aborted) {
				unsubscribe();
				reject(new Error("Handoff cancelled"));
				return;
			}

			if (event.type === "agent_end") {
				unsubscribe();
				const messages = this.agent.state.messages;
				for (let i = messages.length - 1; i >= 0; i--) {
					const msg = messages[i];
					if (msg.role === "assistant") {
						const content = (msg as AssistantMessage).content;
						const textParts = content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text);
						if (textParts.length > 0) {
							handoffText = textParts.join("\n");
							break;
						}
					}
				}
				resolve();
			}
		});

		try {
			// Send the prompt and wait for completion
			await this.prompt(handoffPrompt, { expandPromptTemplates: false });
			await completionPromise;

			if (!handoffText || this.#handoffAbortController.signal.aborted) {
				return undefined;
			}

			// Start a new session with parent reference
			const parentThreadId = this.sessionManager.getSessionId();
			await this.sessionManager.flush();
			await this.sessionManager.newSession({ parentSession: parentThreadId });
			this.agent.reset();
			this.agent.sessionId = this.sessionManager.getSessionId();
			this.#steeringMessages = [];
			this.#followUpMessages = [];
			this.#pendingNextTurnMessages = [];
			this.#todoReminderCount = 0;
			this.#contextWarningEmitted = false;

			// Inject the handoff document as a custom message
			const handoffContent = `<handoff-context thread="${parentThreadId}">\n${handoffText}\n</handoff-context>\n\nThe above is a handoff document from thread \`${parentThreadId}\`. Use this context to continue the work seamlessly. If you need additional details not covered above, use \`read_thread("${parentThreadId}", "your specific question")\` to query the original session.`;
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true);

			// Rebuild agent messages from session
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.replaceMessages(sessionContext.messages);

			return { document: handoffText };
		} finally {
			this.#handoffAbortController = undefined;
		}
	}

	/**
	 * Check if agent stopped after modifying files without running verification.
	 * If so, inject a reminder to verify and continue the conversation.
	 */
	async #checkVerification(): Promise<boolean> {
		if (!this.settings.get("verification.autoCheck")) {
			this.#verificationReminderCount = 0;
			return false;
		}

		if (!this.#turnHasFileModifications) {
			return false;
		}

		const maxReminders = this.settings.get("verification.maxReminders");
		if (this.#verificationReminderCount >= maxReminders) {
			logger.debug("Verification: max reminders reached", { count: this.#verificationReminderCount });
			return false;
		}

		if (this.#turnHasVerificationCommand()) {
			this.#verificationReminderCount = 0;
			this.#turnHasFileModifications = false;
			return false;
		}

		this.#verificationReminderCount++;
		const reminder = renderPromptTemplate(verificationReminderTemplate, {
			attempt: this.#verificationReminderCount,
			maxAttempts: maxReminders,
		});

		logger.debug("Verification: sending reminder", {
			attempt: this.#verificationReminderCount,
		});

		this.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: reminder }],
			timestamp: Date.now(),
		});
		this.agent.continue().catch(() => {});
		return true;
	}

	/**
	 * Check if the current turn included a bash command that looks like a verification step.
	 */
	#turnHasVerificationCommand(): boolean {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "user") break;
			if (msg.role !== "assistant") continue;
			const assistant = msg as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type !== "toolCall" || block.name !== "bash") continue;
				const cmd = (block.arguments as { command?: string })?.command ?? "";
				if (/\b(check|lint|fmt|format|test|typecheck|tsc|biome|eslint|clippy)\b/.test(cmd)) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 */
	async #checkTodoCompletion(): Promise<void> {
		const remindersEnabled = this.settings.get("todo.reminders");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!remindersEnabled || !todosEnabled) {
			this.#todoReminderCount = 0;
			return;
		}

		const remindersMax = this.settings.get("todo.reminders.max");
		if (this.#todoReminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount });
			return;
		}

		// Load current todos from artifacts
		const sessionFile = this.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const todoPath = `${sessionFile.slice(0, -6)}/todos.json`;

		let todos: TodoItem[];
		try {
			const data = await Bun.file(todoPath).json();
			todos = data?.todos ?? [];
		} catch (err) {
			if (isEnoent(err)) {
				this.#todoReminderCount = 0;
			}
			return;
		}

		// Check for incomplete todos
		const incomplete = todos.filter(t => t.status !== "completed");
		if (incomplete.length === 0) {
			this.#todoReminderCount = 0;
			return;
		}

		// Build reminder message
		this.#todoReminderCount++;
		const todoList = incomplete.map(t => `- ${t.content}`).join("\n");
		const reminder =
			`<system_reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#todoReminderCount}/${remindersMax})\n` +
			`</system_reminder>`;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		// Emit event for UI to render notification
		await this.#emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
		});

		// Inject reminder and continue the conversation
		this.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: reminder }],
			timestamp: Date.now(),
		});
		this.agent.continue().catch(() => {});
	}

	// =========================================================================
	// Auto-Handoff
	// =========================================================================

	async #checkAutoHandoff(message: AssistantMessage): Promise<boolean> {
		const handoffSettings = this.settings.getGroup("autoHandoff");
		if (!handoffSettings.enabled) return false;

		// Check if this was a context overflow error
		const contextWindow = this.model?.contextWindow ?? 0;
		if (message.stopReason === "error" && isContextOverflow(message, contextWindow)) {
			return this.#handleContextOverflow();
		}

		// Skip threshold-based handoff if this turn ended with an error
		// (e.g., 429 rate limit) — let retry logic handle those
		if (message.stopReason === "error") return false;

		// Check context usage percentage
		const usage = this.getContextUsage();
		if (!usage || usage.percent == null) return false;

		// Auto-handoff at high threshold
		if (usage.percent >= handoffSettings.handoffThreshold) {
			await this.#emitSessionEvent({ type: "auto_handoff_start", percent: usage.percent });
			try {
				const result = await this.handoff();
				await this.#emitSessionEvent({ type: "auto_handoff_end", success: !!result });
				if (result) {
					this.agent.continue().catch(() => {});
				}
				return !!result;
			} catch (err) {
				// handoff() failed (likely context too full to generate doc)
				// End the current handoff event before falling back to overflow handler
				await this.#emitSessionEvent({ type: "auto_handoff_end", success: false, error: String(err) });
				return this.#handleContextOverflow();
			}
		}

		// Warning at lower threshold (once per session)
		if (usage.percent >= handoffSettings.warningThreshold && !this.#contextWarningEmitted) {
			this.#contextWarningEmitted = true;
			await this.#emitSessionEvent({
				type: "context_warning",
				percent: usage.percent,
				tokens: usage.tokens ?? 0,
				contextWindow: usage.contextWindow,
			});
		}

		return false;
	}

	async #handleContextOverflow(): Promise<boolean> {
		await this.#emitSessionEvent({ type: "auto_handoff_start", percent: 100 });
		try {
			// Can't prompt agent (context full), build lightweight handoff from session state
			const parentThreadId = this.sessionManager.getSessionId();
			await this.sessionManager.flush();
			await this.sessionManager.newSession({ parentSession: parentThreadId });
			this.agent.reset();
			this.agent.sessionId = this.sessionManager.getSessionId();
			this.#steeringMessages = [];
			this.#followUpMessages = [];
			this.#pendingNextTurnMessages = [];
			this.#todoReminderCount = 0;
			this.#contextWarningEmitted = false;

			// Inject a minimal handoff message pointing back to the parent thread
			const handoffContent = `<handoff-context thread="${parentThreadId}">\nContext window reached capacity. This session was automatically created to continue the work.\n\nUse \`read_thread("${parentThreadId}", "your specific question")\` to retrieve context from the previous session as needed.\n</handoff-context>\n\nThe previous session ran out of context space. Read the parent thread to understand what was being worked on and continue.`;
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true);

			// Rebuild agent messages from session
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.replaceMessages(sessionContext.messages);

			await this.#emitSessionEvent({ type: "auto_handoff_end", success: true });
			this.agent.continue().catch(() => {});
			return true;
		} catch (err) {
			logger.error("Auto-handoff overflow fallback failed", { error: String(err) });
			await this.#emitSessionEvent({ type: "auto_handoff_end", success: false, error: String(err) });
			return false;
		}
	}
	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable.
	 */
	#isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is not retryable
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		return isRetryableErrorMessage(err);
	}
	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(message: AssistantMessage): Promise<boolean> {
		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled) return false;

		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		if (this.#retryAttempt > retrySettings.maxRetries) {
			// Max retries exceeded, emit final failure and reset
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this.#retryAttempt = 0;
			this.#resolveRetry(); // Resolve so waitForRetry() completes
			return false;
		}

		const errorMessage = message.errorMessage || "Unknown error";
		let delayMs = retrySettings.baseDelayMs * 2 ** (this.#retryAttempt - 1);

		if (this.model && isUsageLimitErrorMessage(errorMessage)) {
			const retryAfterMs = parseRetryAfterMs(errorMessage);
			const switched = await this.#model.registry.authStorage.markUsageLimitReached(
				this.model.provider,
				this.sessionId,
				{
					retryAfterMs,
					baseUrl: this.model.baseUrl,
				},
			);
			if (switched) {
				delayMs = 0;
			}
		}

		await this.#emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: retrySettings.maxRetries,
			delayMs,
			errorMessage,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.replaceMessages(messages.slice(0, -1));
		}

		// Wait with exponential backoff (abortable)
		// Properly abort and null existing controller before replacing
		if (this.#retryAbortController) {
			this.#retryAbortController.abort();
		}
		this.#retryAbortController = new AbortController();
		try {
			await abortableSleep(delayMs, this.#retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.#resolveRetry();
			return false;
		}
		this.#retryAbortController = undefined;

		// Retry via continue() - use setTimeout to break out of event handler chain
		setTimeout(() => {
			this.agent.continue().catch(() => {
				// Retry failed - will be caught by next agent_end
			});
		}, 0);

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this.#resolveRetry();
	}

	/**
	 * Wait for any in-progress retry to complete.
	 * Returns immediately if no retry is in progress.
	 */
	async #waitForRetry(): Promise<void> {
		if (this.#retryPromise) {
			await this.#retryPromise;
		}
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<BashResult> {
		this.#bashAbortController = new AbortController();

		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: this.#bashAbortController.signal,
				sessionKey: this.sessionId,
			});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this.#bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this.#pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this.#bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	#flushPendingBashMessages(): void {
		if (this.#pendingBashMessages.length === 0) return;

		for (const bashMessage of this.#pendingBashMessages) {
			// Add to agent state
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this.#pendingBashMessages = [];
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as the agent's Python tool, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		this.#pythonAbortController = new AbortController();

		try {
			// Use the same session ID as the Python tool for kernel sharing
			const sessionFile = this.sessionManager.getSessionFile();
			const cwd = this.sessionManager.getCwd();
			const sessionId = sessionFile ? `session:${sessionFile}:cwd:${cwd}` : `cwd:${cwd}`;

			const result = await executePythonCommand(code, {
				cwd,
				sessionId,
				kernelMode: this.settings.get("python.kernelMode"),
				useSharedGateway: this.settings.get("python.sharedGateway"),
				onChunk,
				signal: this.#pythonAbortController.signal,
			});

			this.recordPythonResult(code, result, options);
			return result;
		} finally {
			this.#pythonAbortController = undefined;
		}
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}
	}

	/**
	 * Cancel running Python execution.
	 */
	abortPython(): void {
		this.#pythonAbortController?.abort();
	}

	/** Whether a Python execution is currently running */
	get isPythonRunning(): boolean {
		return this.#pythonAbortController !== undefined;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	/**
	 * Flush pending Python messages to agent state and session.
	 */
	#flushPendingPythonMessages(): void {
		if (this.#pendingPythonMessages.length === 0) return;

		for (const pythonMessage of this.#pendingPythonMessages) {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}

		this.#pendingPythonMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();

		// Emit session_before_switch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.#pendingNextTurnMessages = [];

		// Flush pending writes before switching
		await this.sessionManager.flush();

		// Set new session
		await this.sessionManager.setSessionFile(sessionPath);
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Reload messages
		const sessionContext = this.sessionManager.buildSessionContext();

		// Emit session_switch event to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "resume",
				previousSessionFile,
			});
		}

		this.agent.replaceMessages(sessionContext.messages);

		// Restore model if saved
		const defaultModelStr = sessionContext.models.default;
		if (defaultModelStr) {
			const slashIdx = defaultModelStr.indexOf("/");
			if (slashIdx > 0) {
				const provider = defaultModelStr.slice(0, slashIdx);
				const modelId = defaultModelStr.slice(slashIdx + 1);
				const availableModels = this.#model.registry.getAvailable();
				const match = availableModels.find(m => m.provider === provider && m.id === modelId);
				if (match) {
					this.#model.setModelDirect(match);
				}
			}
		}

		const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
		const defaultThinkingLevel = (this.settings.get("defaultThinkingLevel") ?? "off") as ThinkingLevel;

		if (hasThinkingEntry) {
			// Restore thinking level if saved (setThinkingLevel clamps to model capabilities)
			this.setThinkingLevel(sessionContext.thinkingLevel as ThinkingLevel);
		} else {
			const availableLevels = this.getAvailableThinkingLevels();
			const effectiveLevel = availableLevels.includes(defaultThinkingLevel)
				? defaultThinkingLevel
				: this.#model.clampThinkingLevel(defaultThinkingLevel, availableLevels);
			this.agent.setThinkingLevel(effectiveLevel);
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
		}

		this.#reconnectToAgent();
		return true;
	}

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
	async branch(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_branch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// Clear pending messages (bound to old session state)
		this.#pendingNextTurnMessages = [];

		// Flush pending writes before branching
		await this.sessionManager.flush();

		if (!selectedEntry.parentId) {
			await this.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.sessionManager.buildSessionContext();

		// Emit session_branch event to hooks (after branch completes)
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
		}

		return { selectedText, cancelled: false };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#model.registry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey,
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: options.customInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Update agent state
		const sessionContext = this.sessionManager.buildSessionContext();
		this.agent.replaceMessages(sessionContext.messages);

		// Emit session_tree event
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
		}

		this.#branchSummaryAbortController = undefined;
		return { editorText, cancelled: false, summaryEntry };
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	getSessionStats(): SessionStats {
		return sessionStats.getSessionStats(this.messages, this.sessionFile, this.sessionId);
	}

	getContextUsage(): ContextUsage | undefined {
		return sessionStats.getContextUsage(this.model, this.messages);
	}

	async fetchUsageReports(): Promise<UsageReport[] | null> {
		return sessionStats.fetchUsageReports(this.#model.registry) ?? null;
	}
	async exportToHtml(outputPath?: string): Promise<string> {
		return sessionStats.exportToHtml(this.sessionManager, this.state, outputPath);
	}

	getLastAssistantText(): string | undefined {
		return sessionStats.getLastAssistantText(this.messages);
	}

	formatSessionAsText(): string {
		return sessionStats.formatSessionAsText(this.state);
	}

	formatCompactContext(): string {
		return sessionStats.formatCompactContext(this.messages);
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}

	/**
	 * Emit a custom tool session event (backwards compatibility for older callers).
	 */
	async emitCustomToolSessionEvent(reason: "start" | "switch" | "branch" | "tree" | "shutdown"): Promise<void> {
		if (reason !== "shutdown") return;
		if (this.#extensionRunner?.hasHandlers("session_shutdown")) {
			await this.#extensionRunner.emit({ type: "session_shutdown" });
		}
		await cleanupSshResources();
	}
}
