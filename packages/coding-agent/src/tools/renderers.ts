/**
 * TUI renderers for all tools.
 *
 * Single registry for tool rendering. Every tool — built-in, subagent, MCP,
 * extension — renders through this registry. Tools without an explicit
 * renderer get the default generic renderer.
 */
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { editToolRenderer } from "../patch";
import { renderResult as renderTaskResult, taskToolRenderer } from "../task/render";
import { renderStatusLine } from "../tui";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { bashToolRenderer } from "./bash";
import { calculatorToolRenderer } from "./calculator";
import { exploreConfig } from "./explore";
import { fetchToolRenderer } from "./fetch";
import { findToolRenderer } from "./find";
import { grepToolRenderer } from "./grep";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { librarianConfig } from "./librarian";
import { notebookToolRenderer } from "./notebook";
import { oracleConfig } from "./oracle";
import { pythonToolRenderer } from "./python";
import { readToolRenderer } from "./read";
import { formatExpandHint, replaceTabs, truncateToWidth } from "./render-utils";
import { reviewerConfig } from "./reviewer-tool";
import { sshToolRenderer } from "./ssh";
import type { SubagentConfig } from "./subagent-tool";
import { todoWriteToolRenderer } from "./todo-write";
import { undoEditToolRenderer } from "./undo-edit";
import { writeToolRenderer } from "./write";

export type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value !== null && value !== undefined && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	return null;
}

/**
 * Accepted input shape for registerRenderer.
 * Allows renderers with narrower parameter types (e.g. BashRenderArgs instead of unknown).
 * The registry stores them widened to ToolRenderer — safe because tool-execution.ts
 * always passes the correct args for each tool name.
 */
type ToolRendererInput = {
	renderCall: (args: any, options: any, theme: any) => Component;
	renderResult: (result: any, options: any, theme: any, args?: any) => Component;
	mergeCallAndResult?: boolean;
	inline?: boolean;
};

/**
 * Default renderer for tools without a custom renderer.
 * Shows status line with args preview, JSON tree for structured output.
 */
const defaultRenderer: ToolRenderer = {
	renderCall(args: unknown, options: RenderResultOptions, theme: Theme): Component {
		const label = options.label ?? "Tool";
		const lines: string[] = [];
		lines.push(renderStatusLine({ icon: "pending", title: label }, theme));

		const argsObject = asRecord(args);
		if (argsObject && Object.keys(argsObject).length > 0) {
			const preview = formatArgsInline(argsObject, 70);
			if (preview) {
				lines.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
			}
		}
		return new Text(lines.join("\n"), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	): Component {
		const { expanded = false, isPartial = false } = options;
		const label = options.label ?? "Tool";
		const lines: string[] = [];
		const icon = isPartial ? "pending" : result.isError ? "error" : "success";
		lines.push(renderStatusLine({ icon, title: label }, theme));

		if (expanded && args !== undefined) {
			lines.push("");
			lines.push(theme.fg("dim", "Args"));
			const tree = renderJsonTreeLines(
				args,
				theme,
				JSON_TREE_MAX_DEPTH_EXPANDED,
				JSON_TREE_MAX_LINES_EXPANDED,
				JSON_TREE_SCALAR_LEN_EXPANDED,
			);
			lines.push(...tree.lines);
			if (tree.truncated) {
				lines.push(theme.fg("dim", "…"));
			}
			lines.push("");
		}

		// Output
		const textContent = (result.content?.find(c => c.type === "text")?.text ?? "").trimEnd();
		if (!textContent) {
			lines.push(theme.fg("dim", "(no output)"));
			return new Text(lines.join("\n"), 0, 0);
		}

		// Try JSON tree
		if (textContent.startsWith("{") || textContent.startsWith("[")) {
			try {
				const parsed = JSON.parse(textContent);
				const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
				const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
				const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
				const tree = renderJsonTreeLines(parsed, theme, maxDepth, maxLines, maxScalarLen);
				if (tree.lines.length > 0) {
					lines.push(...tree.lines);
					if (!expanded) {
						lines.push(formatExpandHint(theme, expanded, true));
					} else if (tree.truncated) {
						lines.push(theme.fg("dim", "…"));
					}
					return new Text(lines.join("\n"), 0, 0);
				}
			} catch {
				// Fall through to raw output
			}
		}

		// Raw output
		const outputLines = textContent.split("\n");
		const maxOutputLines = expanded ? 12 : 4;
		const displayLines = outputLines.slice(0, maxOutputLines);
		for (const line of displayLines) {
			lines.push(theme.fg("toolOutput", truncateToWidth(line, 80)));
		}
		if (outputLines.length > maxOutputLines) {
			const remaining = outputLines.length - maxOutputLines;
			lines.push(`${theme.fg("dim", `… ${remaining} more lines`)} ${formatExpandHint(theme, expanded, true)}`);
		} else if (!expanded) {
			lines.push(formatExpandHint(theme, expanded, true));
		}

		return new Text(lines.join("\n"), 0, 0);
	},
};

function createSubagentRenderer(config: SubagentConfig): ToolRendererInput {
	return {
		renderCall(args: unknown, _options: RenderResultOptions, theme: Theme): Component {
			const params = (args ?? {}) as Record<string, unknown>;
			const desc = truncateToWidth(replaceTabs(config.buildDescription(params)), 80);
			return new Text(renderStatusLine({ icon: "pending", title: config.label, description: desc }, theme), 0, 0);
		},
		renderResult: renderTaskResult,
		mergeCallAndResult: true,
	};
}

const subagentConfigs: SubagentConfig[] = [exploreConfig, librarianConfig, oracleConfig, reviewerConfig];

// --- Registry ---

const rendererMap = new Map<string, ToolRenderer>();

function registerBuiltins(): void {
	const builtins: Array<[string, ToolRendererInput]> = [
		["ask", askToolRenderer],
		["bash", bashToolRenderer],
		["python", pythonToolRenderer],
		["calc", calculatorToolRenderer],
		["edit", editToolRenderer],
		["find", findToolRenderer],
		["grep", grepToolRenderer],
		["lsp", lspToolRenderer],
		["notebook", notebookToolRenderer],
		["read", readToolRenderer],
		["ssh", sshToolRenderer],
		["task", taskToolRenderer],
		["todo_write", todoWriteToolRenderer],
		["undo_edit", undoEditToolRenderer],
		["fetch", fetchToolRenderer],
		["web_search", webSearchToolRenderer],
		["write", writeToolRenderer],
	];

	for (const [name, renderer] of builtins) {
		rendererMap.set(name, renderer as ToolRenderer);
	}

	for (const config of subagentConfigs) {
		rendererMap.set(config.name, createSubagentRenderer(config));
	}
}

registerBuiltins();

/**
 * Register a renderer for a tool. Overwrites any existing renderer for that name.
 */
export function registerRenderer(name: string, renderer: ToolRendererInput): void {
	rendererMap.set(name, renderer as ToolRenderer);
}

/**
 * Unregister a renderer for a tool.
 */
export function unregisterRenderer(name: string): void {
	rendererMap.delete(name);
}

/**
 * Get the renderer for a tool. Returns the default renderer if none registered.
 */
export function getRenderer(name: string): ToolRenderer {
	return rendererMap.get(name) ?? defaultRenderer;
}

/**
 * Check if a tool has a custom (non-default) renderer registered.
 */
export function hasRenderer(name: string): boolean {
	return rendererMap.has(name);
}
