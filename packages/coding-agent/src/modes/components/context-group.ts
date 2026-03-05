import type { Component, TUI } from "@nghyane/arcane-tui";
import { Spacer } from "@nghyane/arcane-tui";
import { theme } from "../../theme/theme";
import { formatCount, formatStatusIcon } from "../../ui/render-utils";
import type { ToolExecutionComponent } from "./tool-execution";

const CONTEXT_TOOL_LABELS: Record<string, string> = {
	read: "read",
	grep: "grep",
	find: "find",
	fetch: "fetch",
	search_code: "search",
	lsp: "lsp",
	notebook: "notebook",
};

/**
 * Groups consecutive context-gathering tools (read, grep, find, etc.) into
 * a single collapsible summary line to reduce visual noise.
 *
 * Collapsed: "Gathered context  3 reads, 2 greps, 1 find"
 * Expanded: summary + individual tool components
 */
export class ContextGroupComponent implements Component {
	#entries: Array<{ name: string; component: ToolExecutionComponent }> = [];
	#expanded = false;
	#pendingCount = 0;
	#spacer: Spacer;
	#spinnerFrame = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#ui: TUI;

	constructor(ui: TUI) {
		this.#spacer = new Spacer(1);
		this.#ui = ui;
	}

	addTool(name: string, component: ToolExecutionComponent): void {
		this.#entries.push({ name, component });
		this.#pendingCount++;
		component.setExpanded(this.#expanded);
		this.#startSpinner();
	}

	markDone(): void {
		this.#pendingCount = Math.max(0, this.#pendingCount - 1);
		if (this.#pendingCount <= 0) {
			this.#stopSpinner();
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		for (const entry of this.#entries) {
			entry.component.setExpanded(expanded);
		}
	}

	setMarginTop(lines: number): void {
		this.#spacer.setLines(lines);
	}

	get size(): number {
		return this.#entries.length;
	}

	invalidate(): void {
		for (const entry of this.#entries) {
			entry.component.invalidate?.();
		}
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount === 0) return;
			this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			this.#ui.requestRender();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Margin
		lines.push(...this.#spacer.render(width));

		// Summary line
		const allDone = this.#pendingCount <= 0;
		const icon = allDone
			? formatStatusIcon("success", theme)
			: formatStatusIcon("running", theme, this.#spinnerFrame);
		const label = allDone ? "Gathered context" : "Gathering context…";

		// Count by tool type
		const counts = new Map<string, number>();
		for (const entry of this.#entries) {
			const displayName = CONTEXT_TOOL_LABELS[entry.name] ?? entry.name;
			counts.set(displayName, (counts.get(displayName) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [name, count] of counts) {
			parts.push(formatCount(name, count));
		}
		const summary = parts.join(", ");

		const summaryLine = `  ${icon} ${theme.fg("muted", label)}  ${theme.fg("dim", summary)}`;
		lines.push(summaryLine);

		// Always show individual tool entries, indented under summary
		const indent = "     ";
		const innerWidth = width - indent.length;
		for (let i = 0; i < this.#entries.length; i++) {
			const entryLines = this.#entries[i].component.render(innerWidth);
			for (const line of entryLines) {
				if (line.trim()) {
					lines.push(indent + line);
				}
			}
		}

		return lines;
	}
}
