import { Container, LeftBorderBox, Markdown, Spacer, Text } from "@nghyane/arcane-tui";
import type { BranchSummaryMessage } from "../../session/messages";
import { getMarkdownTheme, theme } from "../../theme/theme";
import { formatClickHint } from "../../ui/render-utils";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 */
export class BranchSummaryMessageComponent extends Container {
	#box: LeftBorderBox;
	#expanded = false;

	constructor(private readonly message: BranchSummaryMessage) {
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

		const label = theme.fg("customMessageLabel", theme.bold("[branch]"));
		this.#box.addChild(new Text(label, 0, 0));
		this.#box.addChild(new Spacer(1));

		if (this.#expanded) {
			const header = "**Branch Summary**\n\n";
			this.#box.addChild(
				new Markdown(header + this.message.summary, 0, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.#box.addChild(
				new Text(`${theme.fg("customMessageText", "Branch summary")} ${formatClickHint(theme)}`, 0, 0),
			);
		}
	}
}
