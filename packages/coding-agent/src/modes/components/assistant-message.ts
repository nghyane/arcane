import type { AssistantMessage } from "@nghyane/arcane-ai";
import { Container, Markdown, Spacer, TERMINAL, Text } from "@nghyane/arcane-tui";
import { logger } from "@nghyane/arcane-utils";
import { hasPendingMermaid, prerenderMermaid } from "../../theme/mermaid-cache";
import { getMarkdownTheme, theme } from "../../theme/theme";

interface CachedBlock {
	type: "text" | "thinking" | "thinking-hidden";
	component: Markdown | Text;
	text: string;
}

/**
 * Component that renders a complete assistant message.
 * Reuses Markdown/Text instances across updates so unchanged blocks skip re-parsing.
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#prerenderInFlight = false;
	#cachedBlocks: CachedBlock[] = [];

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
	) {
		super();

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	#triggerMermaidPrerender(message: AssistantMessage): void {
		if (!TERMINAL.imageProtocol || this.#prerenderInFlight) return;

		// Check if any text content has pending mermaid blocks
		const hasPending = message.content.some(c => c.type === "text" && c.text.trim() && hasPendingMermaid(c.text));
		if (!hasPending) return;

		this.#prerenderInFlight = true;

		// Fire off background prerender
		void (async () => {
			try {
				for (const content of message.content) {
					if (content.type === "text" && content.text.trim() && hasPendingMermaid(content.text)) {
						await prerenderMermaid(content.text);
					}
				}
			} catch (error) {
				logger.warn("Background mermaid prerender failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				this.#prerenderInFlight = false;
				// Invalidate to re-render with cached images
				this.invalidate();
			}
		})();
	}

	updateContent(message: AssistantMessage): void {
		this.#lastMessage = message;
		this.#contentContainer.clear();
		this.#triggerMermaidPrerender(message);

		const hasVisibleContent = message.content.some(
			c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.#contentContainer.addChild(new Spacer(1));
		}

		let blockIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const text = content.text.trim();
				const cached = this.#cachedBlocks[blockIndex];
				let md: Markdown;
				if (cached?.type === "text") {
					md = cached.component as Markdown;
					if (cached.text !== text) {
						md.setText(text);
						cached.text = text;
					}
				} else {
					md = new Markdown(text, 2, 0, getMarkdownTheme());
					this.#cachedBlocks[blockIndex] = { type: "text", component: md, text };
				}
				this.#contentContainer.addChild(md);
				blockIndex++;
			} else if (content.type === "thinking" && content.thinking.trim()) {
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					const cached = this.#cachedBlocks[blockIndex];
					let label: Text;
					if (cached?.type === "thinking-hidden") {
						label = cached.component as Text;
					} else {
						label = new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 2, 0);
						this.#cachedBlocks[blockIndex] = { type: "thinking-hidden", component: label, text: "" };
					}
					this.#contentContainer.addChild(label);
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				} else {
					const text = content.thinking.trim();
					const cached = this.#cachedBlocks[blockIndex];
					let md: Markdown;
					if (cached?.type === "thinking") {
						md = cached.component as Markdown;
						if (cached.text !== text) {
							md.setText(text);
							cached.text = text;
						}
					} else {
						md = new Markdown(text, 2, 0, getMarkdownTheme(), {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						});
						this.#cachedBlocks[blockIndex] = { type: "thinking", component: md, text };
					}
					this.#contentContainer.addChild(md);
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				}
				blockIndex++;
			}
		}

		if (this.#cachedBlocks.length > blockIndex) {
			this.#cachedBlocks.length = blockIndex;
		}

		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("error", abortMessage), 2, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 2, 0));
			}
		}
	}
}
