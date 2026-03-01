import type { TextContent } from "@nghyane/arcane-ai";
import type { Component } from "@nghyane/arcane-tui";
import { Container, LeftBorderBox, Markdown, Spacer, Text } from "@nghyane/arcane-tui";
import type { CustomMessage, SkillPromptDetails } from "../../session/messages";
import { getMarkdownTheme, theme } from "../../theme/theme";

export class SkillMessageComponent extends Container {
	#box: LeftBorderBox;
	#contentComponent?: Component;
	#expanded = false;

	constructor(private readonly message: CustomMessage<SkillPromptDetails>) {
		super();
		this.addChild(new Spacer(1));

		this.#box = new LeftBorderBox(1, 1, s => theme.fg("dim", s));
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		if (this.#contentComponent) {
			this.removeChild(this.#contentComponent);
			this.#contentComponent = undefined;
		}

		this.removeChild(this.#box);
		this.addChild(this.#box);
		this.#box.clear();

		const label = theme.fg("customMessageLabel", theme.bold("[skill]"));
		this.#box.addChild(new Text(label, 0, 0));
		this.#box.addChild(new Spacer(1));

		const details = this.message.details;
		const args = details?.args?.trim();
		const infoLines = [
			`Skill: ${details?.name ?? "unknown"}`,
			args ? `Args: ${args}` : undefined,
			details?.path ? `Path: ${details.path}` : undefined,
			typeof details?.lineCount === "number" ? `Prompt: ${details.lineCount} lines` : undefined,
		].filter((line): line is string => Boolean(line));

		this.#box.addChild(
			new Markdown(infoLines.join("\n"), 0, 0, getMarkdownTheme(), {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);

		if (!this.#expanded) {
			return;
		}

		const text = this.#extractText();
		if (!text) {
			return;
		}

		this.#box.addChild(new Spacer(1));
		const promptHeader = theme.fg("customMessageLabel", theme.bold("Prompt"));
		this.#box.addChild(new Text(promptHeader, 0, 0));
		this.#box.addChild(new Spacer(1));

		this.#contentComponent = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		});
		this.#box.addChild(this.#contentComponent);
	}

	#extractText(): string {
		if (typeof this.message.content === "string") {
			return this.message.content;
		}
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}
}
