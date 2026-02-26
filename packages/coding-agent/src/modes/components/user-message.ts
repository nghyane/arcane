import { Container, Markdown, Spacer } from "@nghyane/arcane-tui";
import { getMarkdownTheme, theme } from "../../theme/theme";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, synthetic = false) {
		super();
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		const leftBorder = theme.fg("accent", "▎");
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", value);
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(text, 1, 1, getMarkdownTheme(), {
				bgColor,
				color,
				leftBorder,
			}),
		);
	}
}
