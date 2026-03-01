import type { AgentTool } from "@nghyane/arcane-agent";
import type { Component, TUI } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { theme } from "../../theme/theme";
import { shortenPath } from "../../ui/render-utils";
import { ToolExecutionComponent, type ToolExecutionHandle, type ToolExecutionOptions } from "./tool-execution";

type ReadEntry = {
	path: string;
	offset?: number;
	limit?: number;
	status: "pending" | "success" | "error";
	text: Text;
};

export class CodeGroupComponent implements Component, ToolExecutionHandle {
	#logsText: Text;
	#orderedSubTools: Component[] = [];
	#entries = new Map<string, { toolCallId: string; component: ToolExecutionComponent }>();
	#expanded = false;
	#logs: string[] = [];
	#abortMessage?: string;

	constructor() {
		this.#logsText = new Text("", 0, 0);
	}

	// --- Component ---

	render(width: number): string[] {
		const lines: string[] = [];

		for (const subTool of this.#orderedSubTools) {
			lines.push(...subTool.render(width - 1));
		}

		if (this.#abortMessage) {
			lines.push(`  ${theme.fg("accent", theme.status.info)} ${theme.fg("muted", this.#abortMessage)}`);
		}

		lines.push(...this.#logsText.render(width - 1));

		// Pad all lines with 1 space to align with thinking/assistant text (paddingX=1)
		return lines.map(line => ` ${line}`);
	}

	invalidate(): void {
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
		const direct = this.#entries.get(toolCallId)?.component;
		if (direct) return direct;
		return undefined;
	}

	// --- Read items (flat, no sub-tree) ---

	#addReadItem(_toolCallId: string, args: any): ToolExecutionHandle {
		const readArgs = args as { path?: string; file_path?: string; offset?: number; limit?: number };
		const text = new Text("", 0, 0);
		const entry: ReadEntry = {
			path: readArgs.file_path || readArgs.path || "",
			offset: readArgs.offset,
			limit: readArgs.limit,
			status: "pending",
			text,
		};
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

	setAbortMessage(message: string): void {
		this.#abortMessage = message;
	}

	// --- Public setters ---

	setLogs(logs: string[]): void {
		this.#logs = logs;
		this.#updateLogs();
	}

	setDone(): void {}

	stepStart(_stepId: string, _intent: string, _parentStepId?: string): void {}

	stepEnd(_stepId: string): void {}

	setProgress(_stepId: string, _message: string): void {}

	#updateLogs(): void {
		if (this.#logs.length === 0) {
			this.#logsText.setText("");
			return;
		}
		const lines = this.#logs.map(log => `  ${theme.tree.vertical} ${theme.fg("dim", log)}`);
		this.#logsText.setText(lines.join("\n"));
	}
}
