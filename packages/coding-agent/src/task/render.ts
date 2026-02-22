import type { Component } from "@nghyane/pi-tui";
import { Text } from "@nghyane/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { formatBadge, formatDuration, formatStatusIcon, replaceTabs, truncateToWidth } from "../tools/render-utils";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine } from "../tui";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		case "completed":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "aborted":
			return formatStatusIcon("aborted", theme);
	}
}

function formatTaskId(id: string): string {
	const segments = id.split(".");
	if (segments.length < 2) return id;
	const parsed = segments.map(segment => segment.match(/^(\d+)-(.+)$/));
	if (parsed.some(match => !match)) return id;
	const indices = parsed.map(match => match![1]).join(".");
	const labels = parsed.map(match => match![2]).join(">");
	return `${indices} ${labels}`;
}

type ToolEntry = { tool: string; args: string; status: "success" | "error" | "running" };

function renderToolLine(entry: ToolEntry, continuePrefix: string, theme: Theme): string {
	const icon =
		entry.status === "running"
			? theme.fg("accent", theme.status.running)
			: entry.status === "error"
				? theme.fg("error", theme.status.error)
				: theme.fg("dim", theme.status.success);
	const toolName = entry.status === "running" ? theme.fg("muted", entry.tool) : theme.fg("dim", entry.tool);
	const args = entry.args ? `  ${theme.fg("dim", truncateToWidth(replaceTabs(entry.args), 50))}` : "";
	return `${continuePrefix}${icon} ${toolName}${args}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// renderCall
// ═══════════════════════════════════════════════════════════════════════════

export function renderCall(args: TaskParams, _options: RenderResultOptions, theme: Theme): Component {
	const lines: string[] = [];
	lines.push(
		renderStatusLine({ icon: "pending", title: "Task", description: `${args.tasks?.length ?? 0} subtasks` }, theme),
	);

	const context = (args.context ?? "").trim();
	if (context) {
		const branch = theme.fg("dim", theme.tree.branch);
		const vertical = theme.fg("dim", theme.tree.vertical);
		const last = theme.fg("dim", theme.tree.last);
		lines.push(` ${branch} ${theme.fg("dim", "Context")}`);
		for (const line of context.split("\n")) {
			lines.push(` ${vertical}  ${line ? theme.fg("muted", replaceTabs(line)) : ""}`);
		}
		lines.push(` ${last} ${theme.fg("dim", "Tasks")}: ${theme.fg("muted", `${args.tasks.length} subtasks`)}`);
		return new Text(lines.join("\n"), 0, 0);
	}

	lines.push(`${theme.fg("dim", "Tasks")}: ${theme.fg("muted", `${args.tasks.length} subtasks`)}`);
	return new Text(lines.join("\n"), 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// renderAgentProgress (streaming)
// ═══════════════════════════════════════════════════════════════════════════

/** Max tool history entries to show during streaming */
const STREAMING_TOOL_LIMIT = 4;

function renderAgentProgress(
	progress: AgentProgress,
	isLast: boolean,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
): string[] {
	const lines: string[] = [];
	const prefix = isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch);
	const continuePrefix = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

	const icon = getStatusIcon(progress.status, theme, spinnerFrame);
	const iconColor: ThemeColor =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

	// Main status line
	const description = progress.description?.trim();
	const displayId = formatTaskId(progress.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)}`;

	if (progress.status === "failed" || progress.status === "aborted") {
		statusLine += ` ${formatBadge(progress.status, iconColor, theme)}`;
	}

	if (progress.durationMs > 0) {
		statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(progress.durationMs))}`;
	}

	lines.push(statusLine);

	// Tool history — show last N completed + current running
	if (progress.status === "running" || progress.status === "completed" || progress.status === "failed") {
		const history = progress.toolHistory;
		const completed = history.filter(t => t.status !== "running");
		const running = history.filter(t => t.status === "running");

		// Show recent completed (last N)
		const showCompleted = expanded ? completed : completed.slice(-STREAMING_TOOL_LIMIT);
		const skipped = completed.length - showCompleted.length;
		if (skipped > 0) {
			lines.push(`${continuePrefix}${theme.fg("dim", `… ${skipped} more`)}`);
		}
		for (const entry of showCompleted) {
			lines.push(renderToolLine(entry, continuePrefix, theme));
		}
		// Show currently running tool
		for (const entry of running) {
			lines.push(renderToolLine(entry, continuePrefix, theme));
		}
	}

	return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// renderAgentResult (final)
// ═══════════════════════════════════════════════════════════════════════════

/** Max tool history entries when collapsed */
const COLLAPSED_TOOL_LIMIT = 3;

function renderAgentResult(result: SingleResult, isLast: boolean, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	const prefix = isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch);
	const continuePrefix = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

	const aborted = result.aborted ?? false;
	const success = !aborted && result.exitCode === 0;
	const icon = aborted ? theme.status.aborted : success ? theme.status.success : theme.status.error;
	const iconColor: ThemeColor = success ? "success" : "error";
	const statusText = aborted ? "aborted" : success ? "done" : "failed";

	// Main status line
	const description = result.description?.trim();
	const displayId = formatTaskId(result.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)} ${formatBadge(statusText, iconColor, theme)}`;
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(statusLine);

	// Tool history
	const history = result.toolHistory ?? [];
	if (history.length > 0) {
		const show = expanded ? history : history.slice(-COLLAPSED_TOOL_LIMIT);
		const skipped = history.length - show.length;
		if (skipped > 0) {
			lines.push(`${continuePrefix}${theme.fg("dim", `… ${skipped} more`)}`);
		}
		for (const entry of show) {
			lines.push(renderToolLine(entry, continuePrefix, theme));
		}
	}

	// Error message for failed tasks
	if (result.error && !success) {
		lines.push(`${continuePrefix}${theme.fg("error", truncateToWidth(result.error, 70))}`);
	}

	return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// renderResult (main entry point)
// ═══════════════════════════════════════════════════════════════════════════

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;

	if (!details) {
		const text = result.content.find(c => c.type === "text")?.text || "";
		return new Text(theme.fg("dim", truncateToWidth(text, 100)), 0, 0);
	}

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const { expanded, isPartial, spinnerFrame } = options;
			const key = new Hasher()
				.bool(expanded)
				.bool(isPartial)
				.u32(spinnerFrame ?? 0)
				.u32(width)
				.digest();
			if (cached?.key === key) return cached.lines;

			const lines: string[] = [];

			if (isPartial && details.progress) {
				details.progress.forEach((progress, i) => {
					const isLast = i === details.progress!.length - 1;
					lines.push(...renderAgentProgress(progress, isLast, expanded, theme, spinnerFrame));
				});
			} else if (details.results && details.results.length > 0) {
				details.results.forEach((res, i) => {
					const isLast = i === details.results.length - 1;
					lines.push(...renderAgentResult(res, isLast, expanded, theme));
				});

				// Summary line
				const abortedCount = details.results.filter(r => r.aborted).length;
				const successCount = details.results.filter(r => !r.aborted && r.exitCode === 0).length;
				const failCount = details.results.length - successCount - abortedCount;
				const parts: string[] = [];
				if (successCount > 0) parts.push(theme.fg("success", `${successCount} succeeded`));
				if (failCount > 0) parts.push(theme.fg("error", `${failCount} failed`));
				if (abortedCount > 0) parts.push(theme.fg("error", `${abortedCount} aborted`));
				parts.push(theme.fg("dim", formatDuration(details.totalDurationMs)));
				lines.push(parts.join(theme.sep.dot));
			}

			if (lines.length === 0) {
				const text = fallbackText.trim() ? fallbackText : "No results";
				const result = [theme.fg("dim", truncateToWidth(text, width))];
				cached = { key, lines: result };
				return result;
			}

			// Check for system notifications in fallback text
			if (fallbackText.trim()) {
				const summaryLines = fallbackText.split("\n");
				const markerIndex = summaryLines.findIndex(
					line => line.includes("<system-notification>") || line.startsWith("Applied patches:"),
				);
				if (markerIndex >= 0) {
					for (const line of summaryLines.slice(markerIndex)) {
						if (!line.trim()) continue;
						lines.push(theme.fg("dim", line));
					}
				}
			}

			const indented = lines.map(line =>
				line.length > 0 ? truncateToWidth(`   ${line}`, width, Ellipsis.Omit) : "",
			);
			cached = { key, lines: indented };
			return indented;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Subprocess tool registry
// ═══════════════════════════════════════════════════════════════════════════

function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

const taskSubprocessHandler = {
	extractData: (event: { result?: { details?: unknown } }) => {
		const details = event.result?.details;
		return isTaskToolDetails(details) ? details : undefined;
	},
	renderFinal: (allData: TaskToolDetails[], theme: Theme, expanded: boolean) => {
		const lines: string[] = [];
		for (const details of allData) {
			if (!details.results || details.results.length === 0) continue;
			details.results.forEach((result, index) => {
				const isLast = index === details.results.length - 1;
				lines.push(...renderAgentResult(result, isLast, expanded, theme));
			});
		}
		return new Text(lines.join("\n"), 0, 0);
	},
};

subprocessToolRegistry.register<TaskToolDetails>("task", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("explore", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("librarian", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("oracle", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("code_review", taskSubprocessHandler);

export const taskToolRenderer = {
	renderCall,
	renderResult,
};
