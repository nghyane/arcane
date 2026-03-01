import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../theme/theme";
import { GrepAppProvider, type SearchCodeSource } from "../web/search/providers/grep";
import { renderSearchCall, renderSearchResult, type SearchRenderDetails } from "../web/search/render";

const grepProvider = new GrepAppProvider();

const searchCodeSchema = Type.Object({
	query: Type.String({ description: "Code pattern to search for across public GitHub repos" }),
	regexp: Type.Optional(Type.Boolean({ description: "Enable regex search (default: false)" })),
	language: Type.Optional(
		Type.String({ description: "Filter by programming language (e.g. TypeScript, Python, Go)" }),
	),
	repo: Type.Optional(Type.String({ description: "Filter by repository (e.g. vercel/next.js)" })),
	limit: Type.Optional(Type.Number({ description: "Max results to return (default: 10)" })),
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
	readonly renderResult = renderSearchResult;

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
