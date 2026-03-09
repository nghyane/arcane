import type { AgentMessage } from "@nghyane/arcane-agent";
import type { AssistantMessage, Message } from "@nghyane/arcane-ai";
import { Spacer, Text, TruncatedText } from "@nghyane/arcane-tui";
import { formatKeyHint, type KeyId } from "../../config/keybindings";
import { settings } from "../../config/settings";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { BranchSummaryMessageComponent } from "../../modes/components/branch-summary-message";
import { ContextGroupComponent } from "../../modes/components/context-group";
import { CustomMessageComponent } from "../../modes/components/custom-message";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { PythonExecutionComponent } from "../../modes/components/python-execution";
import { SkillMessageComponent } from "../../modes/components/skill-message";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { UserMessageComponent } from "../../modes/components/user-message";
import type { InteractiveModeContext } from "../../modes/types";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../../session/messages";
import type { SessionContext } from "../../session/session-manager";
import { formatBytes } from "../../session/streaming-output";
import { theme } from "../../theme/theme";
import { getToolTier, isContextTool } from "../../ui/render-utils";

type TextBlock = { type: "text"; text: string };

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};

export class UiHelpers {
	constructor(private ctx: InteractiveModeContext) {}

	/** Extract text content from a user message */
	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((content): content is TextBlock => content.type === "text");
		return textBlocks.map(block => block.text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	showStatus(message: string, options?: { dim?: boolean }): void {
		if (this.ctx.isBackgrounded) {
			return;
		}
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;
		const rendered = useDim ? theme.fg("dim", message) : message;

		if (last && secondLast && last === this.ctx.lastStatusText && secondLast === this.ctx.lastStatusSpacer) {
			this.ctx.lastStatusText.setText(rendered);
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(rendered, 1, 0);
		this.ctx.chatContainer.addChild(spacer);
		this.ctx.chatContainer.addChild(text);
		this.ctx.lastStatusSpacer = spacer;
		this.ctx.lastStatusText = text;
		this.ctx.ui.requestRender();
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new PythonExecutionComponent(message.code, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
						const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					const renderer = this.ctx.session.extensionRunner?.getMessageRenderer(message.customType);
					// Both HookMessage and CustomMessage have the same structure, cast for compatibility
					const component = new CustomMessageComponent(message as CustomMessage<unknown>, renderer);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
				}
				break;
			}
			case "branchSummary": {
				this.ctx.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "fileMention": {
				// Render compact file mention display
				for (const file of message.files) {
					let suffix: string;
					if (file.skippedReason === "tooLarge") {
						const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
						suffix = `(skipped: ${size})`;
					} else {
						suffix = file.image
							? "(image)"
							: file.lineCount === undefined
								? "(unknown lines)"
								: `(${file.lineCount} lines)`;
					}
					const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
						"accent",
						file.path,
					)} ${theme.fg("dim", suffix)}`;
					this.ctx.chatContainer.addChild(new Text(text, 0, 0));
				}
				break;
			}
			case "user": {
				const textContent = this.ctx.getUserMessageText(message);
				if (textContent) {
					const userComponent = new UserMessageComponent(textContent, message.synthetic ?? false);
					this.ctx.chatContainer.addChild(userComponent);
					if (options?.populateHistory && !message.synthetic) {
						this.ctx.editor.addToHistory(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(message, this.ctx.hideThinkingBlock);
				this.ctx.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after handoff.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.ctx.pendingTools.clear();

		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}

		let currentGroup: ContextGroupComponent | undefined;
		const toolGroups = new Map<string, ContextGroupComponent>();

		for (const message of sessionContext.messages) {
			if (message.role === "assistant") {
				currentGroup = undefined;
				this.ctx.addMessageToChat(message);
				const hasErrorStop = message.stopReason === "aborted" || message.stopReason === "error";
				const errorMessage = hasErrorStop
					? message.stopReason === "aborted"
						? (() => {
								const retryAttempt = this.ctx.session.retryAttempt;
								return retryAttempt > 0
									? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
									: "Operation aborted";
							})()
						: message.errorMessage || "Error"
					: null;

				// Render tool call components with context grouping
				for (const content of message.content) {
					if (content.type !== "toolCall") {
						continue;
					}

					const tier = getToolTier(content.name);
					const tool = this.ctx.session.getToolByName(content.name);
					const component = new ToolExecutionComponent(
						content.name,
						content.arguments,
						{ showImages: settings.get("terminal.showImages"), tier },
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
					);
					component.setExpanded(this.ctx.toolOutputExpanded);

					if (isContextTool(content.name)) {
						if (!currentGroup) {
							currentGroup = new ContextGroupComponent(this.ctx.ui);
							currentGroup.setExpanded(this.ctx.toolOutputExpanded);
							this.ctx.chatContainer.addChild(currentGroup);
						}
						currentGroup.addTool(content.name, component);
						toolGroups.set(content.id, currentGroup);
					} else {
						currentGroup = undefined;
						this.ctx.chatContainer.addChild(component);
					}

					if (hasErrorStop && errorMessage) {
						component.updateResult(
							{ content: [{ type: "text", text: errorMessage }], isError: true },
							false,
							content.id,
						);
						const group = toolGroups.get(content.id);
						if (group) {
							group.markDone();
							toolGroups.delete(content.id);
						}
					} else {
						this.ctx.pendingTools.set(content.id, component);
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = this.ctx.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
					const group = toolGroups.get(message.toolCallId);
					if (group) {
						group.markDone();
						toolGroups.delete(message.toolCallId);
					}
				}
			} else {
				currentGroup = undefined;
				// All other messages use standard rendering
				this.ctx.addMessageToChat(message, options);
			}
		}

		this.ctx.pendingTools.clear();
		this.ctx.ui.requestRender();
	}

	renderInitialMessages(): void {
		// This path is used to rebuild the visible chat transcript (e.g. after custom/debug UI).
		// Clear existing rendered chat first to avoid duplicating the full session in the container.
		this.ctx.chatContainer.clear();
		this.ctx.pendingMessagesContainer.clear();
		this.ctx.pendingBashComponents = [];
		this.ctx.pendingPythonComponents = [];

		// Get aligned messages and entries from session context
		const context = this.ctx.sessionManager.buildSessionContext();
		this.ctx.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});
	}

	clearEditor(): void {
		if (this.ctx.isBackgrounded) {
			return;
		}
		this.ctx.editor.setText("");
		this.ctx.pendingImages = [];
		this.ctx.ui.requestRender();
	}

	showError(errorMessage: string): void {
		if (this.ctx.isBackgrounded) {
			process.stderr.write(`Error: ${errorMessage}\n`);
			return;
		}
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ctx.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		if (this.ctx.isBackgrounded) {
			process.stderr.write(`Warning: ${warningMessage}\n`);
			return;
		}
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ctx.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.chatContainer.addChild(
			new Text(
				theme.bold(theme.fg("warning", "Update Available")) +
					"\n" +
					theme.fg("muted", `New version ${newVersion} is available. Run: `) +
					theme.fg("accent", "arc update"),
				1,
				0,
			),
		);
		this.ctx.chatContainer.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.ui.requestRender();
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.clear();
		const queuedMessages = this.ctx.session.getQueuedMessages() as QueuedMessages;

		const steeringMessages: Array<{ message: string; label: string }> = [];
		for (const message of queuedMessages.steering) {
			steeringMessages.push({ message, label: "Steer" });
		}

		const followUpMessages: Array<{ message: string; label: string }> = [];
		for (const message of queuedMessages.followUp) {
			followUpMessages.push({ message, label: "Follow-up" });
		}

		const allMessages = [...steeringMessages, ...followUpMessages];
		if (allMessages.length > 0) {
			this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
			for (const entry of allMessages) {
				const queuedText = theme.fg("dim", `${entry.label}: ${entry.message}`);
				this.ctx.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
			}
			const dequeueKey = this.ctx.keybindings.getDisplayString("dequeue") || formatKeyHint("alt+up" as KeyId);
			const hintText = theme.fg("dim", `${theme.tree.hook} ${dequeueKey} to edit`);
			this.ctx.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	/** Move pending bash components from pending area to chat */
	flushPendingBashComponents(): void {
		for (const component of this.ctx.pendingBashComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingBashComponents = [];
		for (const component of this.ctx.pendingPythonComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingPythonComponents = [];
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.session.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.session.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}
}
