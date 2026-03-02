import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { logger } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { SessionIndex, type SessionSearchResult } from "../session/session-index";
import type { Theme } from "../theme/theme";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "../ui/render-utils";
import type { ToolSession } from ".";

const findThreadSchema = Type.Object({
	query: Type.String({
		description:
			"Keywords to search past sessions. Supports bare words, quoted phrases, after:7d, before:2026-01-01 date filters.",
	}),
	limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
});

type FindThreadParams = Static<typeof findThreadSchema>;

export interface FindThreadToolDetails {
	results: SessionSearchResult[];
	query: string;
	indexed: boolean;
}

interface FindThreadRenderArgs {
	query?: string;
	limit?: number;
}

export class FindThreadTool implements AgentTool<typeof findThreadSchema, FindThreadToolDetails, Theme> {
	readonly name = "find_thread";
	readonly label = "Find Thread";
	description = [
		"Find past conversation threads by keyword search. Returns thread IDs, titles, dates, and matching snippets.",
		"Use read_thread to get full content from a specific thread.",
		"",
		'Query syntax: bare keywords, "quoted phrases", after:7d, before:2026-01-01 date filters.',
		"",
		"When to use:",
		"- User references past work or previous sessions",
		"- Need context from earlier conversations",
		"- Task may overlap with prior work",
		"",
		"When NOT to use: git history/blame, current session context, generic questions.",
	].join("\n");
	readonly parameters = findThreadSchema;
	readonly concurrency = "shared" as const;

	constructor(readonly _session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: FindThreadParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<FindThreadToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FindThreadToolDetails>> {
		const index = SessionIndex.open();

		try {
			await index.indexAllSessions();
		} catch (error) {
			logger.warn("FindThread: indexing failed", { error: String(error) });
		}

		const limit = Math.min(Math.max(1, params.limit ?? 10), 50);
		const results = index.search(params.query, limit);

		const text =
			results.length > 0 ? JSON.stringify(results, null, 2) : `No threads found matching "${params.query}".`;

		return {
			content: [{ type: "text", text }],
			details: { results, query: params.query, indexed: true },
		};
	}

	renderCall(args: FindThreadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta = args.query ? [`"${args.query}"`] : [];
		const text = renderStatusLine({ icon: "pending", title: "Find Thread", meta }, uiTheme);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindThreadToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: FindThreadRenderArgs,
	): Component {
		const results = result.details?.results ?? [];
		const header = renderStatusLine(
			{ icon: "success", title: "Find Thread", meta: [`${results.length} results`] },
			uiTheme,
		);

		if (results.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text ?? "No results";
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		const { expanded } = options;
		const treeLines = renderTreeList(
			{
				items: results,
				expanded,
				maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
				itemType: "thread",
				renderItem: r =>
					`${uiTheme.fg("accent", r.title)} ${uiTheme.fg("dim", r.date)} ${uiTheme.fg("dim", `(${r.messageCount} msgs)`)}`,
			},
			uiTheme,
		);
		const text = [header, ...treeLines].join("\n");
		return new Text(text, 0, 0);
	}
}
