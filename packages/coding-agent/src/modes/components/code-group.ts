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

type StepState = "active" | "done" | "error";

type StepGroup = {
	stepId: string;
	intent: string;
	state: StepState;
	durationMs?: number;
	progress?: string;
	subTools: Component[];
	entries: Map<string, { toolCallId: string; component: ToolExecutionComponent }>;
	readEntries: Map<string, ReadEntry>;
	headerText: Text;
	progressText: Text;
	startTime: number;
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
	#steps = new Map<string, StepGroup>();
	#orderedSteps: StepGroup[] = [];
	#abortMessage?: string;

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
		lines.push("");
		lines.push(...this.#header.render(width));

		const subToolWidth = Math.max(1, width - TREE_PREFIX_WIDTH);
		const hasSteps = this.#orderedSteps.length > 0;

		if (hasSteps) {
			const totalItems = this.#orderedSteps.length + this.#orderedSubTools.length;
			let idx = 0;
			for (const step of this.#orderedSteps) {
				lines.push(...this.#renderStep(step, subToolWidth, idx === totalItems - 1));
				idx++;
			}
			for (let i = 0; i < this.#orderedSubTools.length; i++) {
				lines.push(
					...this.#renderSubToolWithPrefix(this.#orderedSubTools[i], subToolWidth, idx === totalItems - 1),
				);
				idx++;
			}
		} else {
			for (let i = 0; i < this.#orderedSubTools.length; i++) {
				lines.push(
					...this.#renderSubToolWithPrefix(
						this.#orderedSubTools[i],
						subToolWidth,
						i === this.#orderedSubTools.length - 1,
					),
				);
			}
		}

		if (this.#abortMessage) {
			lines.push(`   ${theme.fg("accent", theme.status.info)} ${theme.fg("muted", this.#abortMessage)}`);
		}

		lines.push(...this.#logsText.render(width));
		return lines;
	}

	invalidate(): void {
		this.#header.invalidate?.();
		this.#logsText.invalidate?.();
		for (const tool of this.#orderedSubTools) {
			tool.invalidate?.();
		}
		for (const step of this.#orderedSteps) {
			step.headerText.invalidate?.();
			step.progressText.invalidate?.();
			for (const tool of step.subTools) {
				tool.invalidate?.();
			}
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
		stepId?: string,
	): ToolExecutionHandle {
		// Route into step group if stepId is provided
		const step = stepId ? this.#steps.get(stepId) : undefined;

		if (toolName === "read") {
			return this.#addReadItem(toolCallId, args, step);
		}

		const component = new ToolExecutionComponent(toolName, args, options, tool, ui, cwd, { compact: true });
		component.setExpanded(this.#expanded);

		if (step) {
			step.entries.set(toolCallId, { toolCallId, component });
			step.subTools.push(component);
		} else {
			this.#entries.set(toolCallId, { toolCallId, component });
			this.#orderedSubTools.push(component);
		}

		return component;
	}

	getSubTool(toolCallId: string): ToolExecutionHandle | undefined {
		const direct = this.#entries.get(toolCallId)?.component;
		if (direct) return direct;
		for (const step of this.#orderedSteps) {
			const entry = step.entries.get(toolCallId)?.component;
			if (entry) return entry;
		}
		return undefined;
	}

	// --- Read items (flat, no sub-tree) ---

	#addReadItem(toolCallId: string, args: any, step?: StepGroup): ToolExecutionHandle {
		const readArgs = args as { path?: string; file_path?: string; offset?: number; limit?: number };
		const text = new Text("", 0, 0);
		const entry: ReadEntry = {
			path: readArgs.file_path || readArgs.path || "",
			offset: readArgs.offset,
			limit: readArgs.limit,
			status: "pending",
			text,
		};
		const targetReadEntries = step ? step.readEntries : this.#readEntries;
		const targetSubTools = step ? step.subTools : this.#orderedSubTools;
		targetReadEntries.set(toolCallId, entry);
		targetSubTools.push(text);
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

	// --- Step management ---

	startStep(stepId: string, intent: string): void {
		const step: StepGroup = {
			stepId,
			intent,
			state: "active",
			subTools: [],
			entries: new Map(),
			readEntries: new Map(),
			headerText: new Text("", 0, 0),
			progressText: new Text("", 0, 0),
			startTime: performance.now(),
		};
		this.#steps.set(stepId, step);
		this.#orderedSteps.push(step);
		this.#updateStepHeader(step);
	}

	endStep(stepId: string, durationMs: number): void {
		const step = this.#steps.get(stepId);
		if (!step) return;
		step.state = "done";
		step.durationMs = durationMs;
		step.progress = undefined;
		step.progressText.setText("");
		this.#updateStepHeader(step);
	}

	updateStepProgress(stepId: string, message: string): void {
		const step = this.#steps.get(stepId);
		if (!step || step.state !== "active") return;
		step.progress = message;
		step.progressText.setText(`      ${theme.fg("dim", message)}`);
	}

	setAbortMessage(message: string): void {
		this.#abortMessage = message;
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
			for (const step of this.#orderedSteps) {
				if (step.state === "active") this.#updateStepHeader(step);
			}
			this.#ui.requestRender();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	#renderSubToolWithPrefix(tool: Component, subToolWidth: number, isLast: boolean): string[] {
		const toolLines = tool.render(subToolWidth);
		const branch = getTreeBranch(isLast, theme);
		const cont = getTreeContinuePrefix(isLast, theme);
		const branchPfx = `   ${theme.fg("dim", branch)} `;
		const contPfx = `   ${theme.fg("dim", cont)}`;

		let firstContent = true;
		const contentLines: string[] = [];
		for (const line of toolLines) {
			if (firstContent && !line.trim()) continue;
			if (firstContent) {
				contentLines.push(`${branchPfx}${line}`);
				firstContent = false;
			} else {
				contentLines.push(line.trim() ? `${contPfx}${line}` : "");
			}
		}
		return firstContent ? [] : contentLines;
	}

	#renderStep(step: StepGroup, subToolWidth: number, isLast: boolean): string[] {
		const lines: string[] = [];
		const branch = getTreeBranch(isLast, theme);
		const branchPfx = `   ${theme.fg("dim", branch)} `;
		const cont = getTreeContinuePrefix(isLast, theme);
		const contPfx = `   ${theme.fg("dim", cont)}`;

		// Step header line
		const headerLines = step.headerText.render(subToolWidth);
		if (headerLines.length > 0) {
			lines.push(`${branchPfx}${headerLines[0]}`);
			for (let i = 1; i < headerLines.length; i++) {
				lines.push(`${contPfx}${headerLines[i]}`);
			}
		}

		// Sub-tools inside the step (only when active or has few items)
		const showSubTools = step.state === "active" || step.subTools.length <= 2;
		if (showSubTools && step.subTools.length > 0) {
			const innerWidth = Math.max(1, subToolWidth - TREE_PREFIX_WIDTH);
			for (let i = 0; i < step.subTools.length; i++) {
				const innerIsLast = i === step.subTools.length - 1 && !step.progress;
				const toolLines = step.subTools[i].render(innerWidth);
				const innerBranch = getTreeBranch(innerIsLast, theme);
				const innerCont = getTreeContinuePrefix(innerIsLast, theme);
				const innerBranchPfx = `${contPfx}   ${theme.fg("dim", innerBranch)} `;
				const innerContPfx = `${contPfx}   ${theme.fg("dim", innerCont)}`;

				let firstContent = true;
				for (const line of toolLines) {
					if (firstContent && !line.trim()) continue;
					if (firstContent) {
						lines.push(`${innerBranchPfx}${line}`);
						firstContent = false;
					} else {
						lines.push(line.trim() ? `${innerContPfx}${line}` : "");
					}
				}
			}
		}

		// Progress line (transient)
		if (step.progress && step.state === "active") {
			const progressLines = step.progressText.render(subToolWidth);
			for (const pLine of progressLines) {
				if (pLine.trim()) lines.push(`${contPfx}${pLine}`);
			}
		}

		return lines;
	}

	#updateStepHeader(step: StepGroup): void {
		let icon: string;
		let suffix = "";

		switch (step.state) {
			case "active":
				icon = theme.fg("accent", this.#spinnerFrames[this.#spinnerFrame] ?? theme.format.bullet);
				break;
			case "done": {
				icon = theme.fg("success", theme.status.success);
				const count = step.subTools.length;
				const parts: string[] = [];
				if (count > 0) parts.push(`${count} tool${count !== 1 ? "s" : ""}`);
				if (step.durationMs !== undefined) {
					const ms = Math.round(step.durationMs);
					parts.push(ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
				}
				if (parts.length > 0) suffix = ` ${theme.fg("dim", `(${parts.join(", ")})`)}`;
				break;
			}
			case "error":
				icon = theme.fg("error", theme.status.error);
				break;
		}

		step.headerText.setText(`${icon} ${theme.fg("muted", step.intent)}${suffix}`);
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
