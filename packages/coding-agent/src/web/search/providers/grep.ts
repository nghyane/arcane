/**
 * grep.app Web Search Provider
 *
 * Cross-repo code search across all public GitHub repositories.
 * No API key required. Supports regex and language filtering.
 */

import type { SearchSource } from "../types";

const GREP_APP_URL = "https://grep.app/api/search";

interface GrepAppHit {
	repo: string;
	path: string;
	branch?: string;
	total_matches?: string;
	content?: {
		snippet?: string;
	};
}

interface GrepAppFacetBucket {
	val: string;
	count: number;
}

interface GrepAppResponse {
	time?: number;
	hits?: {
		total?: number;
		hits?: GrepAppHit[];
	};
	facets?: {
		lang?: { buckets?: GrepAppFacetBucket[] };
		repo?: { buckets?: GrepAppFacetBucket[] };
		path?: { buckets?: GrepAppFacetBucket[] };
	};
}

function stripHtml(html: string): string {
	return html
		.replace(/<mark[^>]*>/g, "")
		.replace(/<\/mark>/g, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();
}

function extractSnippet(hit: GrepAppHit): { lines: string[]; lineNumbers: number[] } {
	const raw = hit.content?.snippet ?? "";
	if (!raw) return { lines: [], lineNumbers: [] };

	const lines: string[] = [];
	const lineNumbers: number[] = [];

	const table = raw.match(/<table[^>]*>(.*?)<\/table>/s);
	if (!table) {
		return { lines: [stripHtml(raw)], lineNumbers: [] };
	}

	const trBlocks = table[1].split(/<\/tr>/);
	for (const tr of trBlocks) {
		const lineMatch = tr.match(/data-line="(\d+)"/);
		if (lineMatch) lineNumbers.push(Number.parseInt(lineMatch[1], 10));

		const preMatch = tr.match(/<pre>(.*?)<\/pre>/s);
		if (preMatch) lines.push(stripHtml(preMatch[1]));
	}
	return { lines, lineNumbers };
}

export interface SearchCodeParams {
	query: string;
	regexp?: boolean;
	language?: string;
	repo?: string;
	limit?: number;
	signal?: AbortSignal;
}

export interface SearchCodeSource extends SearchSource {
	branch?: string;
	lineNumbers?: number[];
	matchCount?: number;
}

export interface SearchCodeResponse {
	provider: "grep";
	sources: SearchCodeSource[];
	total?: number;
	timeMs?: number;
	topLanguages?: GrepAppFacetBucket[];
	topRepos?: GrepAppFacetBucket[];
}

export class GrepAppProvider {
	readonly id = "grep";
	readonly label = "grep.app";

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchCodeParams): Promise<SearchCodeResponse> {
		const url = new URL(GREP_APP_URL);
		url.searchParams.set("q", params.query);
		url.searchParams.set("regexp", params.regexp ? "true" : "false");
		url.searchParams.set("case", "false");
		if (params.language) {
			url.searchParams.set("l", params.language);
		}
		if (params.repo) {
			url.searchParams.set("r", params.repo);
		}

		const response = await fetch(url.toString(), {
			signal: params.signal,
			headers: { Accept: "application/json" },
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`grep.app error (${response.status}): ${text}`);
		}

		const data = (await response.json()) as GrepAppResponse;
		const hits = data.hits?.hits ?? [];
		const limit = params.limit ?? 10;
		const sources: SearchCodeSource[] = [];

		for (const hit of hits.slice(0, limit)) {
			const { lines, lineNumbers } = extractSnippet(hit);
			const branch = hit.branch ?? "HEAD";
			const startLine = lineNumbers[0];
			const lineAnchor = startLine ? `#L${startLine}` : "";

			sources.push({
				title: `${hit.repo}: ${hit.path}`,
				url: `https://github.com/${hit.repo}/blob/${branch}/${hit.path}${lineAnchor}`,
				snippet: lines.length > 0 ? lines.join("\n") : undefined,
				branch,
				lineNumbers: lineNumbers.length > 0 ? lineNumbers : undefined,
				matchCount: hit.total_matches ? Number.parseInt(hit.total_matches, 10) : undefined,
			});
		}

		return {
			provider: "grep",
			sources,
			total: data.hits?.total,
			timeMs: data.time,
			topLanguages: data.facets?.lang?.buckets?.slice(0, 5),
			topRepos: data.facets?.repo?.buckets?.slice(0, 5),
		};
	}
}
