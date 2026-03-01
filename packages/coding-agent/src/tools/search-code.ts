import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatCount, formatErrorMessage, truncateToWidth } from "../ui/render-utils";
import { GrepAppProvider, type SearchCodeSource } from "../web/search/providers/grep";
import { renderSearchCall, type SearchRenderDetails } from "../web/search/render";

const grepProvider = new GrepAppProvider();

const searchCodeSchema = Type.Object({
	query: Type.String({ description: "Search query or code pattern" }),
	regexp: Type.Optional(Type.Boolean({ description: "Treat query as regex" })),
	language: Type.Optional(Type.String({ description: "Filter by programming language" })),
	repo: Type.Optional(Type.String({ description: "Filter by repository (owner/repo)" })),
	limit: Type.Optional(Type.Number({ description: "Max number of results" })),
});

interface SearchCodeToolParams {
	query: string;
	regexp?: boolean;
	language?: string;
	repo?: string;
	limit?: number;
}

export class SearchCodeTool implements AgentTool<typeof searchCodeSchema, SearchRenderDetails, Theme> {
	readonly name = "search_code";
	readonly label = "Code Search";
	readonly description = "Search source code across public GitHub repositories via grep.app";
	readonly parameters = searchCodeSchema;
	readonly renderCall = renderSearchCall;

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails; isError?: boolean },
		_options: RenderResultOptions,
		theme: Theme,
		args?: SearchCodeToolParams,
	): Component {
		if (result.isError || result.details?.error) {
			const errorText =
				result.details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, theme), 0, 0);
		}
		const query = args?.query ? truncateToWidth(args.query, 60) : "code";
		const sourceCount = result.details?.response?.sources?.length ?? 0;
		return new Text(
			renderStatusLine(
				{
					icon: sourceCount > 0 ? "success" : "warning",
					title: "Code Search",
					description: `"${query}"`,
					meta: [formatCount("result", sourceCount)],
				},
				theme,
			),
			0,
			0,
		);
	}

	async execute(
		_toolCallId: string,
		params: SearchCodeToolParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		try {
			const response = await grepProvider.search({
				query: params.query,
				regexp: params.regexp,
				language: params.language,
				repo: params.repo,
				limit: params.limit,
			});

			const parts: string[] = [];
			if (response.sources.length === 0) {
				parts.push("No code results found.");
			} else {
				const header = response.total
					? `Found ${response.sources.length} of ${response.total} total matches across public GitHub repos.`
					: `Found ${response.sources.length} code result(s) across public GitHub repos.`;
				parts.push(header);

				if (response.topLanguages && response.topLanguages.length > 0) {
					parts.push(`Top languages: ${response.topLanguages.map(l => `${l.val} (${l.count})`).join(", ")}`);
				}
				if (response.topRepos && response.topRepos.length > 0) {
					parts.push(`Top repos: ${response.topRepos.map(r => `${r.val} (${r.count})`).join(", ")}`);
				}
				parts.push("");

				for (const source of response.sources as SearchCodeSource[]) {
					const matchInfo = source.matchCount ? ` (${source.matchCount} matches)` : "";
					parts.push(`### ${source.title}${matchInfo}`);
					parts.push(source.url);
					if (source.snippet) {
						const lineInfo = source.lineNumbers?.[0] ? `L${source.lineNumbers[0]}` : "";
						parts.push(`\`\`\`${lineInfo}\n${source.snippet}\n\`\`\``);
					}
					parts.push("");
				}
			}

			return {
				content: [{ type: "text" as const, text: parts.join("\n") }],
				details: { response, error: undefined },
			};
		} catch (error) {
			const message = `Code search failed: ${error instanceof Error ? error.message : String(error)}`;

			return {
				content: [{ type: "text" as const, text: message }],
				details: { response: { provider: "grep" as const, sources: [] }, error: message },
			};
		}
	}
}
