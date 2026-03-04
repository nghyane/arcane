import type { Component } from "@nghyane/arcane-tui";
import { Markdown, Text } from "@nghyane/arcane-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../theme/theme";
import { getMarkdownTheme } from "../theme/theme";
import { Ellipsis, Hasher, type RenderCache } from "../tui";
import {
	formatBadge,
	formatDuration,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../ui/render-utils";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("running", theme, spinnerFrame);
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

type ToolEntry = { tool: string; args: string; status: "success" | "error" | "running" };

const INDENT = "   ";

function renderToolLine(entry: ToolEntry, theme: Theme): string {
	const icon =
		entry.status === "running"
			? theme.fg("accent", theme.status.running)
			: entry.status === "error"
				? theme.fg("error", theme.status.error)
				: theme.fg("dim", theme.status.success);
	const toolName = entry.status === "running" ? theme.fg("muted", entry.tool) : theme.fg("dim", entry.tool);
	const args = entry.args
		? `  ${theme.fg("dim", truncateToWidth(replaceTabs(entry.args), TRUNCATE_LENGTHS.TOOL_ARGS))}`
		: "";
	return `${INDENT}${icon} ${toolName}${args}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified subagent header
// ═══════════════════════════════════════════════════════════════════════════

/** Config for rendering any subagent (task, explore, oracle, etc.) */
export interface SubagentRenderConfig {
	label: string;
	getDescription: (args: Record<string, unknown>) => string;
	getContextLine?: (args: Record<string, unknown>) => string | null;
}

/** Cheap fingerprint of tool state for cache invalidation. */
function toolStateFingerprint(details: TaskToolDetails): number {
	let fp = 0;
	if (details.progress) {
		for (const p of details.progress) {
			fp = (fp * 31 + p.toolHistory.length) | 0;
			const last = p.toolHistory[p.toolHistory.length - 1];
			if (last) fp = (fp * 31 + (last.status === "running" ? 1 : 2)) | 0;
		}
	}
	if (details.results) fp = (fp * 31 + details.results.length) | 0;
	return fp >>> 0;
}

/**
 * Render the stable header block for any subagent.
 * Returns [headerLine, contextLine?] — structure never changes across states.
 */
function renderSubagentHeader(
	config: SubagentRenderConfig,
	args: Record<string, unknown>,
	state: { icon: string; duration?: number; badge?: { text: string; color: ToolUIColor } },
	theme: Theme,
): string[] {
	const desc = truncateToWidth(replaceTabs(config.getDescription(args)), TRUNCATE_LENGTHS.CONTENT);
	let header = `${state.icon} ${theme.fg("accent", theme.bold(config.label))}  ${theme.fg("muted", desc)}`;
	if (state.duration && state.duration > 0) {
		header += `${theme.sep.dot}${theme.fg("dim", formatDuration(state.duration))}`;
	}
	if (state.badge) {
		header += ` ${formatBadge(state.badge.text, state.badge.color, theme)}`;
	}

	const lines = [header];

	const contextLine = config.getContextLine?.(args);
	if (contextLine) {
		lines.push(`${INDENT}${theme.fg("dim", "↳")} ${theme.fg("dim", contextLine)}`);
	}

	return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool history rendering
// ═══════════════════════════════════════════════════════════════════════════

const STREAMING_TOOL_LIMIT = PREVIEW_LIMITS.SUBAGENT_STREAMING_TOOLS;
const COLLAPSED_TOOL_LIMIT = PREVIEW_LIMITS.SUBAGENT_COLLAPSED_TOOLS;
const COLLAPSED_CONCLUSION_LINES = PREVIEW_LIMITS.SUBAGENT_CONCLUSION;

/** Render conclusion text as markdown, returning indented lines with collapsed/expanded limit. */
function renderConclusionMarkdown(text: string, width: number, expanded: boolean, theme: Theme): string[] {
	const md = new Markdown(text.trim(), INDENT.length, 0, getMarkdownTheme());
	const mdLines = md.render(width);
	if (mdLines.length === 0) return [];

	const maxLines = expanded ? mdLines.length : COLLAPSED_CONCLUSION_LINES;
	const show = mdLines.slice(0, maxLines);
	const remaining = mdLines.length - maxLines;
	const lines = ["", ...show];
	if (remaining > 0) {
		lines.push(`${INDENT}${theme.fg("dim", `… ${remaining} more lines`)}`);
	}
	return lines;
}

function renderToolHistory(history: ToolEntry[], expanded: boolean, limit: number, theme: Theme): string[] {
	const lines: string[] = [];
	const completed = history.filter(t => t.status !== "running");
	const running = history.filter(t => t.status === "running");

	const showCompleted = expanded ? completed : completed.slice(-limit);
	const skipped = completed.length - showCompleted.length;
	if (skipped > 0) {
		lines.push(`${INDENT}${theme.fg("dim", `… ${skipped} more`)}`);
	}
	for (const entry of showCompleted) {
		lines.push(renderToolLine(entry, theme));
	}
	if (running.length > 0) {
		for (const entry of running) {
			lines.push(renderToolLine(entry, theme));
		}
	} else if (completed.length > 0) {
		// Between tool calls — reserve empty line to prevent layout shift
		lines.push(INDENT);
	}
	return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Task tool renderCall / renderResult
// ═══════════════════════════════════════════════════════════════════════════

const taskRenderConfig: SubagentRenderConfig = {
	label: "Task",
	getDescription: args => String(args.description ?? ""),
	getContextLine: args => {
		const prompt = String(args.prompt ?? "").trim();
		if (!prompt) return null;
		return `Prompt: ${truncateToWidth(replaceTabs(prompt.split("\n")[0] ?? ""), TRUNCATE_LENGTHS.SUBAGENT_ERROR)}`;
	},
};

export function renderCall(args: TaskParams, options: RenderResultOptions, theme: Theme): Component {
	const params = args as Record<string, unknown>;
	let cached: RenderCache | undefined;
	return {
		render() {
			const frame = options.spinnerFrame ?? 0;
			const key = new Hasher().u32(frame).digest();
			if (cached?.key === key) return cached.lines;
			const icon = formatStatusIcon("running", theme, frame);
			const lines = renderSubagentHeader(taskRenderConfig, params, { icon }, theme);
			cached = { key, lines };
			return lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	if (!result.details) {
		const text = result.content.find(c => c.type === "text")?.text || "";
		return new Text(theme.fg("dim", truncateToWidth(text, TRUNCATE_LENGTHS.LONG)), 0, 0);
	}

	let cached: RenderCache | undefined;

	return {
		render(width) {
			// Read from result ref each render to pick up mutable updates
			const details = result.details!;
			const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
			const { expanded, isPartial, spinnerFrame } = options;
			const key = new Hasher()
				.bool(expanded)
				.bool(isPartial)
				.u32(spinnerFrame ?? 0)
				.u32(width)
				.u32(toolStateFingerprint(details))
				.digest();
			if (cached?.key === key) return cached.lines;

			const lines: string[] = [];
			const args = {} as Record<string, unknown>;

			if (isPartial && details.progress?.length) {
				const p = details.progress[0];
				const icon = getStatusIcon(p.status, theme, spinnerFrame);
				const duration = p.durationMs > 0 ? p.durationMs : undefined;
				const errorColor = "error" as const;
				const badge =
					p.status === "failed" || p.status === "aborted" ? { text: p.status, color: errorColor } : undefined;
				// Use description from progress for header
				const headerArgs = { description: p.description ?? p.id, prompt: p.task };
				lines.push(
					...renderSubagentHeader(
						taskRenderConfig,
						headerArgs as Record<string, unknown>,
						{ icon, duration, badge },
						theme,
					),
				);
				lines.push(...renderToolHistory(p.toolHistory, expanded, STREAMING_TOOL_LIMIT, theme));
			} else if (details.results?.length) {
				const r = details.results[0];
				const aborted = r.aborted ?? false;
				const success = !aborted && r.exitCode === 0;
				const statusText = aborted ? "aborted" : success ? "done" : "failed";
				const iconColor: ToolUIColor = success ? "success" : "error";
				const icon = formatStatusIcon(success ? "success" : "error", theme);
				const headerArgs = { description: r.description ?? r.id, prompt: r.task };
				lines.push(
					...renderSubagentHeader(
						taskRenderConfig,
						headerArgs as Record<string, unknown>,
						{ icon, duration: r.durationMs, badge: { text: statusText, color: iconColor } },
						theme,
					),
				);

				// Tool history
				const history = r.toolHistory ?? [];
				if (history.length > 0) {
					const show = expanded ? history : history.slice(-COLLAPSED_TOOL_LIMIT);
					const skipped = history.length - show.length;
					if (skipped > 0) {
						lines.push(`${INDENT}${theme.fg("dim", `… ${skipped} more`)}`);
					}
					for (const entry of show) {
						lines.push(renderToolLine(entry, theme));
					}
				}

				if (r.error && !success) {
					lines.push(`${INDENT}${theme.fg("error", truncateToWidth(r.error, TRUNCATE_LENGTHS.SUBAGENT_ERROR))}`);
				}
				if (success && fallbackText.trim()) {
					lines.push(...renderConclusionMarkdown(fallbackText, width, expanded, theme));
				}
			} else {
				const icon = formatStatusIcon("running", theme, spinnerFrame);
				lines.push(...renderSubagentHeader(taskRenderConfig, args, { icon }, theme));
			}

			if (lines.length === 0) {
				const result = [truncateToWidth(fallbackText.trim() || theme.fg("dim", "No results"), width)];
				cached = { key, lines: result };
				return result;
			}

			const indented = lines.map(line => (line.length > 0 ? truncateToWidth(line, width, Ellipsis.Omit) : ""));
			cached = { key, lines: indented };
			return indented;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified subagent renderer factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a renderer for any subagent tool (explore, oracle, librarian, code_review).
 *
 * Renders call and result with unified header + tool history + conclusion.
 */
export function createUnifiedSubagentRenderer(config: SubagentRenderConfig): {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: unknown,
	) => Component;
} {
	return {
		renderCall(args: unknown, options: RenderResultOptions, theme: Theme): Component {
			const params = (args ?? {}) as Record<string, unknown>;
			let cached: RenderCache | undefined;
			return {
				render() {
					const frame = options.spinnerFrame ?? 0;
					const key = new Hasher().u32(frame).digest();
					if (cached?.key === key) return cached.lines;
					const icon = formatStatusIcon("running", theme, frame);
					const lines = renderSubagentHeader(config, params, { icon }, theme);
					cached = { key, lines };
					return lines;
				},
				invalidate() {
					cached = undefined;
				},
			};
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
			options: RenderResultOptions,
			theme: Theme,
			args?: unknown,
		): Component {
			const params = (args ?? {}) as Record<string, unknown>;

			if (!result.details) {
				const text = result.content.find(c => c.type === "text")?.text || "No results";
				return new Text(theme.fg("dim", truncateToWidth(text, TRUNCATE_LENGTHS.LONG)), 0, 0);
			}

			let cached: RenderCache | undefined;

			return {
				render(width) {
					// Read from result ref each render to pick up mutable updates
					const details = result.details as TaskToolDetails;
					const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
					const { expanded, isPartial, spinnerFrame } = options;
					const key = new Hasher()
						.bool(expanded)
						.bool(isPartial)
						.u32(spinnerFrame ?? 0)
						.u32(width)
						.u32(toolStateFingerprint(details))
						.digest();
					if (cached?.key === key) return cached.lines;

					const lines: string[] = [];

					// Stable header — same structure as renderCall
					if (isPartial && details.progress?.length) {
						const p = details.progress[0];
						const icon = getStatusIcon(p.status, theme, spinnerFrame);
						const duration = p.durationMs > 0 ? p.durationMs : undefined;
						const errorColor = "error" as const;
						const badge =
							p.status === "failed" || p.status === "aborted"
								? { text: p.status, color: errorColor }
								: undefined;
						lines.push(...renderSubagentHeader(config, params, { icon, duration, badge }, theme));
						lines.push(...renderToolHistory(p.toolHistory, expanded, STREAMING_TOOL_LIMIT, theme));
					} else if (details.results?.length) {
						const r = details.results[0];
						const aborted = r.aborted ?? false;
						const success = !aborted && r.exitCode === 0;
						const statusText = aborted ? "aborted" : success ? "done" : "failed";
						const iconColor: ToolUIColor = success ? "success" : "error";
						const icon = formatStatusIcon(success ? "success" : "error", theme);
						lines.push(
							...renderSubagentHeader(
								config,
								params,
								{
									icon,
									duration: r.durationMs,
									badge: { text: statusText, color: iconColor },
								},
								theme,
							),
						);

						const history = r.toolHistory ?? [];
						if (history.length > 0) {
							const show = expanded ? history : history.slice(-COLLAPSED_TOOL_LIMIT);
							const skipped = history.length - show.length;
							if (skipped > 0) {
								lines.push(`${INDENT}${theme.fg("dim", `… ${skipped} more`)}`);
							}
							for (const entry of show) {
								lines.push(renderToolLine(entry, theme));
							}
						}

						if (r.error && !success) {
							lines.push(
								`${INDENT}${theme.fg("error", truncateToWidth(r.error, TRUNCATE_LENGTHS.SUBAGENT_ERROR))}`,
							);
						}
						if (success && fallbackText.trim()) {
							lines.push(...renderConclusionMarkdown(fallbackText, width, expanded, theme));
						}
					} else {
						const icon = formatStatusIcon("running", theme, spinnerFrame);
						lines.push(...renderSubagentHeader(config, params, { icon }, theme));
					}

					if (lines.length === 0) {
						const text = fallbackText.trim() ? fallbackText : "No results";
						const result = [theme.fg("dim", truncateToWidth(text, width))];
						cached = { key, lines: result };
						return result;
					}

					const indented = lines.map(line => (line.length > 0 ? truncateToWidth(line, width, Ellipsis.Omit) : ""));
					cached = { key, lines: indented };
					return indented;
				},
				invalidate() {
					cached = undefined;
				},
			};
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Subprocess tool registry
// ═══════════════════════════════════════════════════════════════════════════

function renderAgentResult(result: SingleResult, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	const aborted = result.aborted ?? false;
	const success = !aborted && result.exitCode === 0;
	const icon = aborted ? theme.status.aborted : success ? theme.status.success : theme.status.error;
	const iconColor: ThemeColor = success ? "success" : "error";
	const statusText = aborted ? "aborted" : success ? "done" : "failed";

	const description = result.description?.trim();
	const titlePart = description || result.id;
	let statusLine = `${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)} ${formatBadge(statusText, iconColor, theme)}`;
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;
	lines.push(statusLine);

	const history = result.toolHistory ?? [];
	if (history.length > 0) {
		const show = expanded ? history : history.slice(-COLLAPSED_TOOL_LIMIT);
		const skipped = history.length - show.length;
		if (skipped > 0) {
			lines.push(`${INDENT}${theme.fg("dim", `… ${skipped} more`)}`);
		}
		for (const entry of show) {
			lines.push(renderToolLine(entry, theme));
		}
	}

	if (result.error && !success) {
		lines.push(`${INDENT}${theme.fg("error", truncateToWidth(result.error, TRUNCATE_LENGTHS.SUBAGENT_ERROR))}`);
	}

	return lines;
}

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
			for (const result of details.results) {
				lines.push(...renderAgentResult(result, expanded, theme));
			}
		}
		return new Text(lines.join("\n"), 0, 0);
	},
};

subprocessToolRegistry.register<TaskToolDetails>("task", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("explore", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("librarian", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("oracle", taskSubprocessHandler);
subprocessToolRegistry.register<TaskToolDetails>("code_review", taskSubprocessHandler);
