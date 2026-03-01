/**
 * Exa TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for Exa search results.
 */
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatCount, formatMoreItems, getDomain, truncateToWidth } from "../ui/render-utils";
import type { ExaRenderDetails } from "./types";

const MAX_COLLAPSED_RESULTS = 5;

/** Render Exa result with tree-based layout */
export function renderExaResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ExaRenderDetails },
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const details = result.details;
	const response = details?.response;
	const results = response?.results ?? [];
	const resultCount = results.length;

	const icon = details?.error ? "error" : resultCount > 0 ? "success" : "warning";

	const header = renderStatusLine(
		{
			icon,
			title: "Exa Search",
			meta: [formatCount("result", resultCount)],
		},
		uiTheme,
	);

	let text = header;

	if (details?.error) {
		const clean = details.error.replace(/^Error:\s*/, "").trim();
		text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("error", clean || "Unknown error")}`;
		return new Text(text, 0, 0);
	}

	if (!response || resultCount === 0) {
		text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", "No results")}`;
		return new Text(text, 0, 0);
	}

	const { expanded } = options;
	const maxItems = expanded ? results.length : Math.min(results.length, MAX_COLLAPSED_RESULTS);
	const remaining = results.length - maxItems;

	for (let i = 0; i < maxItems; i++) {
		const res = results[i];
		const isLast = i === maxItems - 1 && remaining === 0;
		const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
		const title = truncateToWidth(res.title ?? "Untitled", 70);
		const domain = res.url ? getDomain(res.url) : "";
		const domainPart = domain ? ` ${uiTheme.fg("dim", `(${domain})`)}` : "";
		text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg("accent", title)}${domainPart}`;
	}

	if (remaining > 0) {
		text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", formatMoreItems(remaining, "result"))}`;
	}

	return new Text(text, 0, 0);
}

/** Render Exa call (query/args preview) */
export function renderExaCall(args: Record<string, unknown>, toolName: string, uiTheme: Theme): Component {
	const toolLabel = toolName || "Exa Search";
	const query = typeof args.query === "string" ? truncateToWidth(args.query, 80) : "?";
	const numResults = typeof args.num_results === "number" ? args.num_results : undefined;

	let text = `${uiTheme.fg("toolTitle", toolLabel)} ${uiTheme.fg("accent", query)}`;
	if (numResults !== undefined) {
		text += ` ${uiTheme.fg("muted", `results:${numResults}`)}`;
	}

	return new Text(text, 0, 0);
}
