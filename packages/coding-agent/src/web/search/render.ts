/**
 * Web Search TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for web search results.
 */

import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../theme/theme";
import { renderStatusLine } from "../../tui";
import { formatCount, formatMoreItems, getDomain, truncateToWidth } from "../../ui/render-utils";
import { getSearchProvider } from "./provider";
import type { SearchResponse } from "./types";

const MAX_COLLAPSED_SOURCES = 5;

export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

/** Render web search result with tree-based layout */
export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		provider?: string;
		allowLongAnswer?: boolean;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;
	const response = details?.response;
	const sources = Array.isArray(response?.sources) ? response.sources : [];
	const sourceCount = sources.length;
	const searchQueries = Array.isArray(response?.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const provider = response?.provider;

	const providerLabel = provider
		? provider === "none"
			? "None"
			: provider === "grep"
				? "grep.app"
				: getSearchProvider(provider).label
		: "auto";
	const queryPreview = args?.query
		? truncateToWidth(args.query, 80)
		: searchQueries[0]
			? truncateToWidth(searchQueries[0], 80)
			: undefined;

	const header = renderStatusLine(
		{
			icon: sourceCount > 0 ? "success" : details?.error ? "error" : "warning",
			title: "Web Search",
			description: queryPreview,
			meta: [formatCount("source", sourceCount), providerLabel],
		},
		theme,
	);

	let text = header;

	if (details?.error) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("error", details.error)}`;
		return new Text(text, 0, 0);
	}

	const { expanded } = options;
	const maxItems = expanded ? sources.length : Math.min(sources.length, MAX_COLLAPSED_SOURCES);
	const remaining = sources.length - maxItems;

	for (let i = 0; i < maxItems; i++) {
		const src = sources[i];
		const isLast = i === maxItems - 1 && remaining === 0;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		const titleText =
			typeof src.title === "string" && src.title.trim()
				? src.title
				: typeof src.url === "string" && src.url.trim()
					? src.url
					: "Untitled";
		const title = truncateToWidth(titleText, 70);
		const url = typeof src.url === "string" ? src.url : "";
		const domain = url ? getDomain(url) : "";
		const domainPart = domain ? ` ${theme.fg("dim", `(${domain})`)}` : "";
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", title)}${domainPart}`;
	}

	if (remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, "source"))}`;
	}

	return new Text(text, 0, 0);
}

/** Render web search call (query preview) */
export function renderSearchCall(
	args: { query?: string; provider?: string; [key: string]: unknown },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const provider = args.provider ?? "auto";
	const query = truncateToWidth(args.query ?? "", 80);
	const text = renderStatusLine(
		{
			icon: "running",
			spinnerFrame: options.spinnerFrame,
			title: "Web Search",
			description: query,
			meta: [provider],
		},
		theme,
	);
	return new Text(text, 0, 0);
}
