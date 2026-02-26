import { afterEach, describe, expect, it, mock } from "bun:test";
import { GrepAppProvider } from "@nghyane/arcane/web/search/providers/grep";

/**
 * Tests for the search_code tool execute logic.
 * Tests through GrepAppProvider directly — SearchCodeTool.execute is a thin wrapper.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown, status = 200) {
	globalThis.fetch = mock(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		),
	) as any;
}

describe("search_code output formatting", () => {
	const provider = new GrepAppProvider();

	it("produces header with total count", async () => {
		mockFetch({
			time: 50,
			hits: {
				total: 500,
				hits: [
					{
						repo: "org/repo",
						path: "src/main.ts",
						branch: "main",
						total_matches: "3",
						content: {
							snippet:
								'<table class="highlight-table"><tr data-line="10"><td><div class="lineno">10</div></td><td><div class="highlight"><pre>hello</pre></div></td></tr></table>',
						},
					},
				],
			},
			facets: {
				lang: { buckets: [{ val: "TypeScript", count: 200 }] },
				repo: { buckets: [{ val: "org/repo", count: 100 }] },
			},
		});

		const result = await provider.search({ query: "hello" });

		expect(result.total).toBe(500);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].title).toBe("org/repo: src/main.ts");
		expect(result.sources[0].matchCount).toBe(3);
		expect(result.sources[0].url).toContain("#L10");
		expect(result.topLanguages).toHaveLength(1);
		expect(result.topRepos).toHaveLength(1);
	});

	it("returns empty sources for no results", async () => {
		mockFetch({ hits: { total: 0, hits: [] } });

		const result = await provider.search({ query: "nonexistent_xyz" });
		expect(result.sources).toHaveLength(0);
	});

	it("throws on API error", async () => {
		globalThis.fetch = mock(() => Promise.resolve(new Response("rate limited", { status: 429 }))) as any;

		await expect(provider.search({ query: "test" })).rejects.toThrow("grep.app error (429)");
	});

	it("throws on network failure", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as any;

		await expect(provider.search({ query: "test" })).rejects.toThrow("network down");
	});

	it("forwards all params correctly", async () => {
		mockFetch({ hits: { total: 0, hits: [] } });

		await provider.search({
			query: "catch.*Error",
			regexp: true,
			language: "Rust",
			repo: "tokio-rs/tokio",
			limit: 5,
		});

		const call = (globalThis.fetch as any).mock.calls[0];
		const url = new URL(call[0] as string);
		expect(url.searchParams.get("q")).toBe("catch.*Error");
		expect(url.searchParams.get("regexp")).toBe("true");
		expect(url.searchParams.get("l")).toBe("Rust");
		expect(url.searchParams.get("r")).toBe("tokio-rs/tokio");
	});
});
