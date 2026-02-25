/**
 * grep.app Web Search Provider
 *
 * Cross-repo code search across all public GitHub repositories.
 * No API key required. Supports regex and language filtering.
 */

import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

const GREP_APP_URL = "https://grep.app/api/search";

interface GrepAppHit {
	repo: string;
	path: string;
	content?: {
		snippet?: string;
	};
}

interface GrepAppResponse {
	hits?: {
		total?: number;
		hits?: GrepAppHit[];
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

function extractSnippet(hit: GrepAppHit): string {
	const raw = hit.content?.snippet ?? "";
	if (!raw) return "";
	const table = raw.match(/<table[^>]*>(.*?)<\/table>/s);
	if (!table) return stripHtml(raw);
	const rows = table[1].matchAll(/<tr[^>]*>.*?<td><div class="highlight"><pre>(.*?)<\/pre><\/div><\/td><\/tr>/gs);
	const lines: string[] = [];
	for (const row of rows) {
		lines.push(stripHtml(row[1]));
	}
	return lines.join("\n");
}

export class GrepAppProvider extends SearchProvider {
	readonly id = "grep";
	readonly label = "grep.app";

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		const url = new URL(GREP_APP_URL);
		url.searchParams.set("q", params.query);
		url.searchParams.set("regexp", "false");
		url.searchParams.set("case", "false");

		const response = await fetch(url.toString(), {
			signal: params.signal,
			headers: { Accept: "application/json" },
		});

		if (!response.ok) {
			const text = await response.text();
			throw new SearchProviderError("grep", `grep.app error (${response.status}): ${text}`, response.status);
		}

		const data = (await response.json()) as GrepAppResponse;
		const hits = data.hits?.hits ?? [];
		const limit = params.limit ?? 10;
		const sources: SearchSource[] = [];

		for (const hit of hits.slice(0, limit)) {
			const snippet = extractSnippet(hit);
			sources.push({
				title: `${hit.repo}: ${hit.path}`,
				url: `https://github.com/${hit.repo}/blob/HEAD/${hit.path}`,
				snippet: snippet || undefined,
			});
		}

		return {
			provider: "grep",
			sources,
		};
	}
}
