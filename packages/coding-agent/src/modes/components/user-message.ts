import { Container, LeftBorderBox, Markdown, Spacer } from "@nghyane/arcane-tui";
import { getMarkdownTheme, theme } from "../../theme/theme";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, synthetic = false) {
		super();
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", value);
		this.addChild(new Spacer(1));
		const borderBox = new LeftBorderBox(1, 1, s => theme.fg("accent", s));
		borderBox.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color }));
		this.addChild(borderBox);
	}
}
