import { Container, LeftBorderBox, Markdown, Spacer, Text } from "@nghyane/arcane-tui";
import type { CompactionSummaryMessage } from "../../session/messages";
import { getMarkdownTheme, theme } from "../../theme/theme";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 */
export class CompactionSummaryMessageComponent extends Container {
	#box: LeftBorderBox;
	#expanded = false;

	constructor(private readonly message: CompactionSummaryMessage) {
		super();
		this.addChild(new Spacer(1));
		this.#box = new LeftBorderBox(1, 1, s => theme.fg("dim", s));
		this.addChild(this.#box);
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		this.#box.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", theme.bold("[compaction]"));
		this.#box.addChild(new Text(label, 0, 0));
		this.#box.addChild(new Spacer(1));

		if (this.#expanded) {
			const header = `**Compacted from ${tokenStr} tokens**\n\n`;
			this.#box.addChild(
				new Markdown(header + this.message.summary, 0, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.#box.addChild(new Text(theme.fg("customMessageText", `Compacted from ${tokenStr} tokens`), 0, 0));
			if (this.message.shortSummary) {
				this.#box.addChild(new Text(theme.fg("customMessageText", this.message.shortSummary), 0, 1));
			}
		}
	}
}
