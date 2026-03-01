/**
 * Component for displaying bash command execution with streaming output.
 * Tree-style output: tail 4 lines on success, all on error.
 */

import { sanitizeText } from "@nghyane/arcane-natives";
import { Container, Loader, Text, type TUI } from "@nghyane/arcane-tui";
import { getSymbolTheme, theme } from "../../theme/theme";
import type { TruncationMeta } from "../../tools/output-meta";
import { renderStatusLine } from "../../tui/status-line";
import { formatCount, replaceTabs } from "../../ui/render-utils";

const TAIL_LINES = 4;
const MAX_DISPLAY_LINE_CHARS = 4000;

export class BashExecutionComponent extends Container {
	#outputLines: string[] = [];
	#status: "running" | "complete" | "cancelled" | "error" = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	#headerText: Text;
	#bodyText: Text;

	constructor(
		private readonly command: string,
		ui: TUI,
		_excludeFromContext = false,
	) {
		super();

		this.#headerText = new Text(
			renderStatusLine({ icon: "running", title: "Bash", description: `$ ${command}` }, theme),
			0,
			0,
		);
		this.addChild(this.#headerText);

		this.#bodyText = new Text("", 0, 0);
		this.addChild(this.#bodyText);

		this.#loader = new Loader(
			ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Running\u2026 (esc to cancel)",
			getSymbolTheme().spinnerFrames,
		);
		this.addChild(this.#loader);
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		const clean = sanitizeText(chunk);
		const newLines = clean.split("\n").map(line => this.#clampDisplayLine(line));
		if (this.#outputLines.length > 0 && newLines.length > 0) {
			this.#outputLines[this.#outputLines.length - 1] = this.#clampDisplayLine(
				`${this.#outputLines[this.#outputLines.length - 1]}${newLines[0]}`,
			);
			this.#outputLines.push(...newLines.slice(1));
		} else {
			this.#outputLines.push(...newLines);
		}
		this.#updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta },
	): void {
		this.#exitCode = exitCode;
		this.#status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.#truncation = options?.truncation;
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}
		this.#loader.stop();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		const isError = this.#status === "error";
		const isDone = this.#status !== "running";
		const lines = this.#outputLines.filter(l => l.trim());
		const total = lines.length;

		// Update header
		if (isDone) {
			const icon = isError ? "error" : this.#status === "cancelled" ? "warning" : "success";
			const meta: string[] = [];
			if (isError && this.#exitCode !== undefined) meta.push(`exit ${this.#exitCode}`);
			if (total > 0) meta.push(formatCount("line", total));
			this.#headerText.setText(
				renderStatusLine({ icon, title: "Bash", description: `$ ${this.command}`, meta }, theme),
			);
		}

		// Build tree-style body
		const bodyLines: string[] = [];
		if (total > 0) {
			const showAll = isError || this.#expanded;
			const displayLines = showAll ? lines : lines.slice(-TAIL_LINES);
			const skipped = total - displayLines.length;

			if (skipped > 0) {
				bodyLines.push(theme.fg("dim", `\u2026 (${skipped} earlier lines)`));
			}
			for (let i = 0; i < displayLines.length; i++) {
				bodyLines.push(theme.fg("toolOutput", replaceTabs(displayLines[i])));
			}
			if (this.#truncation) {
				bodyLines.push(theme.fg("warning", "output truncated"));
			}
			if (!showAll && skipped > 0) {
				bodyLines.push(theme.fg("dim", "(Ctrl+O for full output)"));
			}
		}

		this.#bodyText.setText(bodyLines.length > 0 ? bodyLines.join("\n") : "");
	}

	#clampDisplayLine(line: string): string {
		if (line.length <= MAX_DISPLAY_LINE_CHARS) return line;
		const omitted = line.length - MAX_DISPLAY_LINE_CHARS;
		return `${line.slice(0, MAX_DISPLAY_LINE_CHARS)}\u2026 [${omitted} chars omitted]`;
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputLines = clean ? clean.split("\n").map(line => this.#clampDisplayLine(line)) : [];
	}

	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	getCommand(): string {
		return this.command;
	}
}
