import type { AgentTool } from "@nghyane/arcane-agent";
import type { Component, TUI } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { getSymbolTheme, theme } from "../../theme/theme";
import { getTreeBranch, getTreeContinuePrefix } from "../../tui";
import { shortenPath } from "../../ui/render-utils";
import { ToolExecutionComponent, type ToolExecutionHandle, type ToolExecutionOptions } from "./tool-execution";

/** Visible width of the tree prefix added to each sub-tool line. */
const TREE_PREFIX_WIDTH = 6; // 3 leading spaces + branch/continue chars + trailing space

type ReadEntry = {
	path: string;
	offset?: number;
	limit?: number;
	status: "pending" | "success" | "error";
	text: Text;
};

export class CodeGroupComponent implements Component, ToolExecutionHandle {
	#header: Text;
	#logsText: Text;
	#orderedSubTools: Component[] = [];
	#entries = new Map<string, { toolCallId: string; component: ToolExecutionComponent }>();
	#readEntries = new Map<string, ReadEntry>();
	#intent = "";
	#expanded = false;
	#logs: string[] = [];
	#done = false;
	#ui: TUI;
	#spinnerFrames: string[];
	#spinnerFrame = 0;
	#spinnerInterval?: NodeJS.Timeout;

	constructor(ui: TUI) {
		this.#ui = ui;
		this.#header = new Text("", 0, 0);
		this.#logsText = new Text("", 0, 0);
		this.#spinnerFrames = getSymbolTheme().spinnerFrames;
		this.#startSpinner();
		this.#updateHeader();
	}

	// --- Component ---

	render(width: number): string[] {
		const lines: string[] = [];

		// Spacer
		lines.push("");

		// Header
		lines.push(...this.#header.render(width));

		// Sub-tools with tree connectors
		const subToolWidth = Math.max(1, width - TREE_PREFIX_WIDTH);
		for (let i = 0; i < this.#orderedSubTools.length; i++) {
			const isLast = i === this.#orderedSubTools.length - 1;
			const tool = this.#orderedSubTools[i];
			const toolLines = tool.render(subToolWidth);

			const branch = getTreeBranch(isLast, theme);
			const cont = getTreeContinuePrefix(isLast, theme);
			const branchPfx = `   ${theme.fg("dim", branch)} `;
			const contPfx = `   ${theme.fg("dim", cont)}`;

			let firstContent = true;
			const contentLines: string[] = [];
			for (const line of toolLines) {
				// Skip leading empty lines (from Spacer(1) in ToolExecutionComponent)
				if (firstContent && !line.trim()) continue;

				if (firstContent) {
					contentLines.push(`${branchPfx}${line}`);
					firstContent = false;
				} else {
					contentLines.push(line.trim() ? `${contPfx}${line}` : "");
				}
			}
			// Only emit if the sub-tool produced visible content
			if (!firstContent) {
				lines.push(...contentLines);
			}
		}

		// Logs
		lines.push(...this.#logsText.render(width));

		return lines;
	}

	invalidate(): void {
		this.#header.invalidate?.();
		this.#logsText.invalidate?.();
		for (const tool of this.#orderedSubTools) {
			tool.invalidate?.();
		}
	}

	// --- ToolExecutionHandle (no-ops on the group itself) ---

	updateArgs(_args: any, _toolCallId?: string): void {}

	updateResult(
		_result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		_isPartial?: boolean,
		_toolCallId?: string,
	): void {}

	setArgsComplete(_toolCallId?: string): void {}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const entry of this.#entries.values()) {
			entry.component.setExpanded(expanded);
		}
	}

	// --- Sub-tool management ---

	addSubTool(
		toolCallId: string,
		toolName: string,
		args: any,
		tool: AgentTool | undefined,
		options: ToolExecutionOptions,
		ui: TUI,
		cwd: string,
	): ToolExecutionHandle {
		if (toolName === "read") {
			return this.#addReadItem(toolCallId, args);
		}
		const component = new ToolExecutionComponent(toolName, args, options, tool, ui, cwd, { compact: true });
		component.setExpanded(this.#expanded);
		this.#entries.set(toolCallId, { toolCallId, component });
		this.#orderedSubTools.push(component);
		return component;
	}

	getSubTool(toolCallId: string): ToolExecutionHandle | undefined {
		return this.#entries.get(toolCallId)?.component;
	}

	// --- Read items (flat, no sub-tree) ---

	#addReadItem(toolCallId: string, args: any): ToolExecutionHandle {
		const readArgs = args as { path?: string; file_path?: string; offset?: number; limit?: number };
		const text = new Text("", 0, 0);
		const entry: ReadEntry = {
			path: readArgs.file_path || readArgs.path || "",
			offset: readArgs.offset,
			limit: readArgs.limit,
			status: "pending",
			text,
		};
		this.#readEntries.set(toolCallId, entry);
		this.#orderedSubTools.push(text);
		this.#updateReadDisplay(entry);

		return {
			updateArgs: (newArgs: any, _toolCallId?: string) => {
				const a = newArgs as { path?: string; file_path?: string; offset?: number; limit?: number };
				entry.path = a.file_path || a.path || entry.path;
				entry.offset = a.offset ?? entry.offset;
				entry.limit = a.limit ?? entry.limit;
				this.#updateReadDisplay(entry);
			},
			updateResult: (result: any, isPartial?: boolean, _toolCallId?: string) => {
				if (isPartial) return;
				entry.status = result.isError ? "error" : "success";
				this.#updateReadDisplay(entry);
			},
			setArgsComplete: () => {},
			setExpanded: () => {},
		};
	}

	#updateReadDisplay(entry: ReadEntry): void {
		const statusIcon =
			entry.status === "success"
				? theme.fg("success", theme.status.success)
				: entry.status === "error"
					? theme.fg("error", theme.status.error)
					: theme.fg("dim", theme.status.pending);
		const filePath = shortenPath(entry.path);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", "…");
		if (entry.offset !== undefined || entry.limit !== undefined) {
			const startLine = entry.offset ?? 1;
			const endLine = entry.limit !== undefined ? startLine + entry.limit - 1 : "";
			pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
		}
		entry.text.setText(`${statusIcon} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay}`.trimEnd());
	}

	// --- Public setters ---

	setIntent(intent: string): void {
		this.#intent = intent;
		this.#updateHeader();
	}

	setLogs(logs: string[]): void {
		this.#logs = logs;
		this.#updateLogs();
	}

	setDone(): void {
		this.#done = true;
		this.#stopSpinner();
		this.#updateHeader();
	}

	// --- Rendering ---

	#updateHeader(): void {
		const icon = this.#done
			? theme.fg("success", theme.status.success)
			: theme.fg("accent", this.#spinnerFrames[this.#spinnerFrame] ?? theme.format.bullet);
		const intent = this.#intent || "Running";
		this.#header.setText(` ${icon} ${theme.fg("muted", intent)}`);
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			if (this.#done) return;
			this.#spinnerFrame = (this.#spinnerFrame + 1) % this.#spinnerFrames.length;
			this.#updateHeader();
			this.#ui.requestRender();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	#updateLogs(): void {
		if (this.#logs.length === 0) {
			this.#logsText.setText("");
			return;
		}
		const lines = this.#logs.map(log => `   ${theme.tree.vertical} ${theme.fg("dim", log)}`);
		this.#logsText.setText(lines.join("\n"));
	}
}
