import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatMoreItems, PREVIEW_LIMITS, TRUNCATE_LENGTHS, truncateToWidth } from "../ui/render-utils";
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

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value !== null && value !== undefined && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	return null;
}

export interface DefaultRenderer {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: unknown,
	) => Component;
}

export const defaultRenderer: DefaultRenderer = {
	renderCall(args: unknown, options: RenderResultOptions, theme: Theme): Component {
		const label = options.label ?? "Tool";
		const lines: string[] = [];
		lines.push(renderStatusLine({ icon: "pending", title: label }, theme));

		const argsObject = asRecord(args);
		if (argsObject && Object.keys(argsObject).length > 0) {
			const preview = formatArgsInline(argsObject, TRUNCATE_LENGTHS.SUBAGENT_ERROR);
			if (preview) {
				lines.push(theme.fg("dim", preview));
			}
		}
		return new Text(lines.join("\n"), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		_args?: unknown,
	): Component {
		const { expanded = false, isPartial = false } = options;
		const label = options.label ?? "Tool";
		const lines: string[] = [];
		const icon = isPartial ? "pending" : result.isError ? "error" : "success";
		lines.push(renderStatusLine({ icon, title: label }, theme));

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
					if (tree.truncated) {
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
		const maxOutputLines = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
		const displayLines = outputLines.slice(0, maxOutputLines);
		for (const line of displayLines) {
			lines.push(theme.fg("toolOutput", truncateToWidth(line, TRUNCATE_LENGTHS.CONTENT)));
		}
		if (outputLines.length > maxOutputLines) {
			const remaining = outputLines.length - maxOutputLines;
			lines.push(theme.fg("dim", formatMoreItems(remaining, "line")));
		}

		return new Text(lines.join("\n"), 0, 0);
	},
};
