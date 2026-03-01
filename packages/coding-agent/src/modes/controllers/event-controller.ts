import { toolDetails } from "@nghyane/arcane-agent";
import { Loader, TERMINAL, Text } from "@nghyane/arcane-tui";
import { settings } from "../../config/settings";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { CodeGroupComponent } from "../../modes/components/code-group";
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";
import { getSymbolTheme, theme } from "../../theme/theme";

export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	#codeGroups = new Map<string, CodeGroupComponent>();
	#lastThinkingCount = 0;
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;

	constructor(private ctx: InteractiveModeContext) {}

	#resetReadGroup(): void {
		this.#lastReadGroup = undefined;
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			this.ctx.chatContainer.addChild(new Text("", 0, 0));
			const group = new ReadToolGroupComponent();
			group.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#updateWorkingMessageFromIntent(intent: string | undefined): void {
		const trimmed = intent?.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed} (esc to interrupt)`);
	}

	#ensureCodeGroup(id: string): CodeGroupComponent {
		let group = this.#codeGroups.get(id);
		if (!group) {
			this.#resetReadGroup();
			group = new CodeGroupComponent();
			group.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(group);
			this.#codeGroups.set(id, group);
			this.ctx.pendingTools.set(id, group);
		}
		return group;
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
				this.#lastIntent = undefined;
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
					this.#resetReadGroup();
					this.ctx.addMessageToChat(event.message);
					this.ctx.ui.requestRender();
				} else if (event.message.role === "user") {
					this.#resetReadGroup();
					this.ctx.addMessageToChat(event.message);
					if (!event.message.synthetic) {
						this.ctx.editor.setText("");
						this.ctx.updatePendingMessagesDisplay();
					}
					this.ctx.ui.requestRender();
				} else if (event.message.role === "fileMention") {
					this.#resetReadGroup();
					this.ctx.addMessageToChat(event.message);
					this.ctx.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.#lastThinkingCount = 0;
					this.#resetReadGroup();
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
					this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);

					const thinkingCount = this.ctx.streamingMessage.content.filter(
						content => content.type === "thinking" && content.thinking.trim(),
					).length;
					if (thinkingCount > this.#lastThinkingCount) {
						this.#resetReadGroup();
						this.#lastThinkingCount = thinkingCount;
					}

					for (const content of this.ctx.streamingMessage.content) {
						if (content.type !== "toolCall") continue;
						// Code Mode: create group component early during streaming for intent display
						if (content.name === "code") {
							this.#ensureCodeGroup(content.id);
							continue;
						}

						if (!this.ctx.pendingTools.has(content.id)) {
							if (content.name === "read") {
								const group = this.#getReadGroup();
								group.updateArgs(content.arguments, content.id);
								this.ctx.pendingTools.set(content.id, group);
								continue;
							}

							this.#resetReadGroup();
							this.ctx.chatContainer.addChild(new Text("", 0, 0));
							const tool = this.ctx.session.getToolByName(content.name);
							const component = new ToolExecutionComponent(
								content.name,
								content.arguments,
								{
									showImages: settings.get("terminal.showImages"),
								},
								tool,
								this.ctx.ui,
								this.ctx.sessionManager.getCwd(),
							);
							component.setExpanded(this.ctx.toolOutputExpanded);
							this.ctx.chatContainer.addChild(component);
							this.ctx.pendingTools.set(content.id, component);
						} else {
							const component = this.ctx.pendingTools.get(content.id);
							if (component) {
								component.updateArgs(content.arguments, content.id);
							}
						}
					}

					// Update working message with intent — skip for code tools that already have a visible group
					for (const content of this.ctx.streamingMessage.content) {
						if (content.type !== "toolCall") continue;
						if (this.#codeGroups.has(content.id)) continue;
					}

					this.ctx.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.ctx.streamingComponent && event.message.role === "assistant") {
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
				if (!this.#codeGroups.has(event.toolCallId)) this.#updateWorkingMessageFromIntent(event.intent);
				if (event.toolName === "code") {
					this.#ensureCodeGroup(event.toolCallId);
					this.ctx.ui.requestRender();
					break;
				}
				// Route sub-tools into their parent code group
				if (event.parentToolCallId) {
					const parentGroup = this.#codeGroups.get(event.parentToolCallId);
					if (parentGroup) {
						const tool = event.tool ?? this.ctx.session.getToolByName(event.toolName);
						const handle = parentGroup.addSubTool(
							event.toolCallId,
							event.toolName,
							event.args,
							tool,
							{
								showImages: settings.get("terminal.showImages"),
							},
							this.ctx.ui,
							this.ctx.sessionManager.getCwd(),
						);
						this.ctx.pendingTools.set(event.toolCallId, handle);
						this.ctx.ui.requestRender();
						break;
					}
				}

				if (!this.ctx.pendingTools.has(event.toolCallId)) {
					if (event.toolName === "read") {
						const group = this.#getReadGroup();
						group.updateArgs(event.args, event.toolCallId);
						this.ctx.pendingTools.set(event.toolCallId, group);
						this.ctx.ui.requestRender();
						break;
					}

					this.#resetReadGroup();
					const tool = event.tool ?? this.ctx.session.getToolByName(event.toolName);
					const component = new ToolExecutionComponent(
						event.toolName,
						event.args,
						{
							showImages: settings.get("terminal.showImages"),
						},
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
					this.ctx.pendingTools.set(event.toolCallId, component);
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
					this.ctx.ui.requestRender();
				}
				// Code Mode: finalize the group when the "code" tool ends
				if (event.toolName === "code") {
					const group = this.#codeGroups.get(event.toolCallId);
					if (group) {
						const details = toolDetails("code", (event.result.details ?? {}) as Record<string, unknown>);
						if (details?.logs) {
							group.setLogs(details.logs);
						}
						group.setDone();
						this.#codeGroups.delete(event.toolCallId);
					}
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

			case "step_start": {
				const group = this.#codeGroups.get(event.toolCallId);
				group?.stepStart(event.stepId, event.intent, event.parentStepId);
				break;
			}

			case "step_end": {
				const group = this.#codeGroups.get(event.toolCallId);
				group?.stepEnd(event.stepId);
				break;
			}

			case "step_progress": {
				const group = this.#codeGroups.get(event.toolCallId);
				group?.setProgress(event.stepId, event.message);
				break;
			}

			case "execution_abort": {
				const group = this.#codeGroups.get(event.toolCallId);
				if (group) {
					group.setAbortMessage(event.message);
					this.ctx.ui.requestRender();
				}
				break;
			}

			case "agent_end":
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
				this.#codeGroups.clear();
				this.ctx.ui.requestRender();
				this.sendCompletionNotification();
				break;

			case "auto_compaction_start": {
				this.ctx.autoCompactionEscapeHandler = this.ctx.editor.onEscape;
				this.ctx.editor.onEscape = () => {
					this.ctx.session.abortCompaction();
				};
				this.ctx.statusContainer.clear();
				const reasonText = event.reason === "overflow" ? "Context overflow detected, " : "";
				this.ctx.autoCompactionLoader = new Loader(
					this.ctx.ui,
					spinner => theme.fg("accent", spinner),
					text => theme.fg("muted", text),
					`${reasonText}Auto-compacting… (esc to cancel)`,
					getSymbolTheme().spinnerFrames,
				);
				this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
				this.ctx.ui.requestRender();
				break;
			}

			case "auto_compaction_end": {
				if (this.ctx.autoCompactionEscapeHandler) {
					this.ctx.editor.onEscape = this.ctx.autoCompactionEscapeHandler;
					this.ctx.autoCompactionEscapeHandler = undefined;
				}
				if (this.ctx.autoCompactionLoader) {
					this.ctx.autoCompactionLoader.stop();
					this.ctx.autoCompactionLoader = undefined;
					this.ctx.statusContainer.clear();
				}
				if (event.aborted) {
					this.ctx.showStatus("Auto-compaction cancelled");
				} else if (event.result) {
					this.ctx.chatContainer.clear();
					this.ctx.rebuildChatFromMessages();
					this.ctx.addMessageToChat({
						role: "compactionSummary",
						tokensBefore: event.result.tokensBefore,
						summary: event.result.summary,
						shortSummary: event.result.shortSummary,
						timestamp: Date.now(),
					});
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
				} else {
					this.ctx.showWarning("Auto-compaction failed; continuing without compaction");
				}
				await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
				this.ctx.ui.requestRender();
				break;
			}

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
				const component = new TtsrNotificationComponent(event.rules);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				this.ctx.ui.requestRender();
				break;
			}

			case "todo_reminder": {
				const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
				this.ctx.chatContainer.addChild(component);
				this.ctx.ui.requestRender();
				break;
			}
		}
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
