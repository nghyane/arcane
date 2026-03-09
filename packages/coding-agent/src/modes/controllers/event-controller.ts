import { type AgentTool, toolDetails } from "@nghyane/arcane-agent";
import { Loader, TERMINAL } from "@nghyane/arcane-tui";
import { settings } from "../../config/settings";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { ContextGroupComponent } from "../../modes/components/context-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";
import { getSymbolTheme, theme } from "../../theme/theme";
import { getToolTier, isContextTool } from "../../ui/render-utils";

const STREAM_RENDER_INTERVAL_MS = 32;

export class EventController {
	#lastThinkingCount = 0;
	#renderedCustomMessages = new Set<string>();
	#currentContextGroup?: ContextGroupComponent;
	#toolGroups = new Map<string, ContextGroupComponent>();
	#streamRenderTimer?: Timer;
	#pendingStreamMessage?: AgentSessionEvent;

	constructor(private ctx: InteractiveModeContext) {}

	#flushStreamRender(): void {
		const pending = this.#pendingStreamMessage;
		if (pending && "message" in pending && pending.message.role === "assistant" && this.ctx.streamingComponent) {
			this.#pendingStreamMessage = undefined;
			this.ctx.streamingComponent.updateContent(pending.message);
			this.ctx.ui.requestRender();
		}
		const timer = setTimeout(() => {
			// Guard against orphan callbacks surviving clearTimeout after message_end
			if (this.#streamRenderTimer !== timer) return;
			if (this.#pendingStreamMessage) {
				this.#flushStreamRender();
			} else {
				this.#streamRenderTimer = undefined;
			}
		}, STREAM_RENDER_INTERVAL_MS);
		this.#streamRenderTimer = timer;
	}

	subscribeToAgent(): void {
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.handleEvent(event);
		});
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorTopBorder();

		switch (event.type) {
			case "agent_start":
				if (this.ctx.retryEscapeHandler) {
					this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
					this.ctx.retryEscapeHandler = undefined;
				}
				if (this.ctx.retryLoader) {
					this.ctx.retryLoader.stop();
					this.ctx.retryLoader = undefined;
					this.ctx.statusContainer.clear();
				}
				if (this.ctx.loadingAnimation) {
					this.ctx.loadingAnimation.stop();
				}
				this.ctx.statusContainer.clear();
				this.ctx.loadingAnimation = new Loader(
					this.ctx.ui,
					spinner => theme.fg("accent", spinner),
					text => theme.fg("muted", text),
					`Working… (esc to interrupt)`,
					getSymbolTheme().spinnerFrames,
				);
				this.ctx.statusContainer.addChild(this.ctx.loadingAnimation);
				this.ctx.applyPendingWorkingMessage();
				this.ctx.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "hookMessage" || event.message.role === "custom") {
					const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
					if (this.#renderedCustomMessages.has(signature)) {
						break;
					}
					this.#renderedCustomMessages.add(signature);
					this.#finalizeContextGroup();
					this.ctx.addMessageToChat(event.message);
					this.ctx.ui.requestRender();
				} else if (event.message.role === "user") {
					this.#finalizeContextGroup();
					this.ctx.addMessageToChat(event.message);
					if (!event.message.synthetic) {
						this.ctx.editor.setText("");
						this.ctx.updatePendingMessagesDisplay();
					}
					this.ctx.ui.requestRender();
				} else if (event.message.role === "fileMention") {
					this.#finalizeContextGroup();
					this.ctx.addMessageToChat(event.message);
					this.ctx.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.#lastThinkingCount = 0;
					this.#finalizeContextGroup();
					this.ctx.streamingComponent = new AssistantMessageComponent(undefined, this.ctx.hideThinkingBlock);
					this.ctx.streamingMessage = event.message;
					this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
					this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
					this.ctx.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.ctx.streamingComponent && event.message.role === "assistant") {
					this.ctx.streamingMessage = event.message;

					// Tool calls need immediate processing (new tool components)
					for (const content of this.ctx.streamingMessage.content) {
						if (content.type !== "toolCall") continue;
						if (!this.ctx.pendingTools.has(content.id)) {
							const tool = this.ctx.session.getToolByName(content.name);
							this.#appendTool(content.id, content.name, content.arguments, tool);
						} else {
							const component = this.ctx.pendingTools.get(content.id);
							if (component) {
								component.updateArgs(content.arguments, content.id);
							}
						}
					}

					const thinkingCount = this.ctx.streamingMessage.content.filter(
						content => content.type === "thinking" && content.thinking.trim(),
					).length;
					if (thinkingCount > this.#lastThinkingCount) {
						this.#lastThinkingCount = thinkingCount;
					}

					// Throttle text/thinking render updates to avoid re-parsing markdown every token
					this.#pendingStreamMessage = event;
					if (!this.#streamRenderTimer) {
						this.#flushStreamRender();
					}
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.ctx.streamingComponent && event.message.role === "assistant") {
					// Flush any throttled stream render and stop the timer
					if (this.#streamRenderTimer) {
						clearTimeout(this.#streamRenderTimer);
						this.#streamRenderTimer = undefined;
						this.#pendingStreamMessage = undefined;
					}
					this.ctx.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.ctx.streamingMessage.stopReason === "aborted" && !this.ctx.session.isTtsrAbortPending) {
						const retryAttempt = this.ctx.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.ctx.streamingMessage.errorMessage = errorMessage;
					}
					if (this.ctx.session.isTtsrAbortPending && this.ctx.streamingMessage.stopReason === "aborted") {
						const msgWithoutAbort = { ...this.ctx.streamingMessage, stopReason: "stop" as const };
						this.ctx.streamingComponent.updateContent(msgWithoutAbort);
					} else {
						this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
					}

					if (
						this.ctx.streamingMessage.stopReason !== "aborted" &&
						this.ctx.streamingMessage.stopReason !== "error"
					) {
						for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
							component.setArgsComplete(toolCallId);
						}
					}
					this.ctx.streamingComponent = undefined;
					this.ctx.streamingMessage = undefined;
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
				}
				this.ctx.ui.requestRender();
				break;

			case "tool_execution_start": {
				if (event.intent) this.ctx.setWorkingMessage(`${event.intent} (esc to interrupt)`);

				if (!this.ctx.pendingTools.has(event.toolCallId)) {
					const tool = event.tool ?? this.ctx.session.getToolByName(event.toolName);
					this.#appendTool(event.toolCallId, event.toolName, event.args, tool);
					this.ctx.ui.requestRender();
				}
				break;
			}

			case "tool_execution_update": {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true, event.toolCallId);
					this.ctx.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.ctx.pendingTools.delete(event.toolCallId);
					// Mark context group completion
					const group = this.#toolGroups.get(event.toolCallId);
					if (group) {
						group.markDone();
						this.#toolGroups.delete(event.toolCallId);
					}
					this.ctx.ui.requestRender();
				}
				// Update todo display when todo_write tool completes
				if (event.toolName === "todo_write" && !event.isError) {
					const details = toolDetails("todo_write", (event.result.details ?? {}) as Record<string, unknown>);
					if (details?.todos) {
						this.ctx.setTodos(details.todos);
					}
				} else if (event.toolName === "todo_write" && event.isError) {
					const textContent = event.result.content.find(
						(content): content is { type: "text"; text: string } => content.type === "text",
					)?.text;
					this.ctx.showWarning(
						`Todo update failed${textContent ? `: ${textContent}` : ". Progress may be stale until todo_write succeeds."}`,
					);
				}
				break;
			}

			case "agent_end":
				this.#finalizeContextGroup();
				if (this.ctx.loadingAnimation) {
					this.ctx.loadingAnimation.stop();
					this.ctx.loadingAnimation = undefined;
					this.ctx.statusContainer.clear();
				}
				if (this.ctx.streamingComponent) {
					this.ctx.chatContainer.removeChild(this.ctx.streamingComponent);
					this.ctx.streamingComponent = undefined;
					this.ctx.streamingMessage = undefined;
				}
				this.ctx.pendingTools.clear();
				this.#toolGroups.clear();
				this.ctx.ui.requestRender();
				this.sendCompletionNotification();
				break;

			case "auto_retry_start": {
				this.ctx.retryEscapeHandler = this.ctx.editor.onEscape;
				this.ctx.editor.onEscape = () => {
					this.ctx.session.abortRetry();
				};
				this.ctx.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.ctx.retryLoader = new Loader(
					this.ctx.ui,
					spinner => theme.fg("warning", spinner),
					text => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s… (esc to cancel)`,
					getSymbolTheme().spinnerFrames,
				);
				this.ctx.statusContainer.addChild(this.ctx.retryLoader);
				this.ctx.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				if (this.ctx.retryEscapeHandler) {
					this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
					this.ctx.retryEscapeHandler = undefined;
				}
				if (this.ctx.retryLoader) {
					this.ctx.retryLoader.stop();
					this.ctx.retryLoader = undefined;
					this.ctx.statusContainer.clear();
				}
				if (!event.success) {
					this.ctx.showError(
						`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`,
					);
				}
				this.ctx.ui.requestRender();
				break;
			}

			case "ttsr_triggered": {
				this.#finalizeContextGroup();
				const component = new TtsrNotificationComponent(event.rules);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				this.ctx.ui.requestRender();
				break;
			}

			case "todo_reminder": {
				this.#finalizeContextGroup();
				const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
				this.ctx.chatContainer.addChild(component);
				this.ctx.ui.requestRender();
				break;
			}
		}
	}

	#appendTool(toolCallId: string, toolName: string, args: unknown, tool: AgentTool | undefined): void {
		const tier = getToolTier(toolName);
		const component = new ToolExecutionComponent(
			toolName,
			args,
			{ showImages: settings.get("terminal.showImages"), tier },
			tool,
			this.ctx.ui,
			this.ctx.sessionManager.getCwd(),
		);
		component.setExpanded(this.ctx.toolOutputExpanded);

		if (isContextTool(toolName)) {
			if (!this.#currentContextGroup) {
				this.#currentContextGroup = new ContextGroupComponent(this.ctx.ui);
				this.#currentContextGroup.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(this.#currentContextGroup);
			}
			this.#currentContextGroup.addTool(toolName, component);
			this.#toolGroups.set(toolCallId, this.#currentContextGroup);
		} else {
			this.#finalizeContextGroup();
			this.ctx.chatContainer.addChild(component);
		}

		this.ctx.pendingTools.set(toolCallId, component);
	}

	#finalizeContextGroup(): void {
		this.#currentContextGroup = undefined;
	}

	sendCompletionNotification(): void {
		if (this.ctx.isBackgrounded === false) return;
		const notify = settings.get("completion.notify");
		if (notify === "off") return;
		const title = this.ctx.sessionManager.getSessionName();
		const message = title ? `${title}: Complete` : "Complete";
		TERMINAL.sendNotification(message);
	}

	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type !== "agent_end") {
			return;
		}
		if (this.ctx.session.queuedMessageCount > 0 || this.ctx.session.isStreaming) {
			return;
		}
		this.sendCompletionNotification();
		await this.ctx.shutdown();
	}
}
