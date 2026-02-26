import { afterEach, describe, expect, it, mock } from "bun:test";
import { GrepAppProvider } from "@nghyane/arcane/web/search/providers/grep";

describe("GrepAppProvider", () => {
	const provider = new GrepAppProvider();

	it("has correct id and label", () => {
		expect(provider.id).toBe("grep");
		expect(provider.label).toBe("grep.app");
	});

	it("is always available", () => {
		expect(provider.isAvailable()).toBe(true);
	});
});

describe("GrepAppProvider.search", () => {
	const provider = new GrepAppProvider();
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

	it("sends correct query params for basic search", async () => {
		mockFetch({ hits: { total: 0, hits: [] } });
		await provider.search({ query: "hello world" });

		const call = (globalThis.fetch as any).mock.calls[0];
		const url = new URL(call[0] as string);
		expect(url.searchParams.get("q")).toBe("hello world");
		expect(url.searchParams.get("regexp")).toBe("false");
		expect(url.searchParams.get("case")).toBe("false");
		expect(url.searchParams.has("l")).toBe(false);
		expect(url.searchParams.has("r")).toBe(false);
	});

	it("sends language and repo params when provided", async () => {
		mockFetch({ hits: { total: 0, hits: [] } });
		await provider.search({ query: "test", language: "TypeScript", repo: "vercel/next.js" });

		const call = (globalThis.fetch as any).mock.calls[0];
		const url = new URL(call[0] as string);
		expect(url.searchParams.get("l")).toBe("TypeScript");
		expect(url.searchParams.get("r")).toBe("vercel/next.js");
	});

	it("sends regexp=true when enabled", async () => {
		mockFetch({ hits: { total: 0, hits: [] } });
		await provider.search({ query: "catch.*Error", regexp: true });

		const call = (globalThis.fetch as any).mock.calls[0];
		const url = new URL(call[0] as string);
		expect(url.searchParams.get("regexp")).toBe("true");
	});

	it("parses hits with branch and total_matches", async () => {
		mockFetch({
			time: 42,
			hits: {
				total: 100,
				hits: [
					{
						repo: "org/repo",
						path: "src/index.ts",
						branch: "main",
						total_matches: "5",
						content: {
							snippet:
								'<table class="highlight-table"><tr data-line="10"><td><div class="lineno">10</div></td><td><div class="highlight"><pre>const x = 1;</pre></div></td></tr></table>',
						},
					},
				],
			},
			facets: {
				lang: { buckets: [{ val: "TypeScript", count: 80 }] },
				repo: { buckets: [{ val: "org/repo", count: 50 }] },
			},
		});

		const result = await provider.search({ query: "const x" });

		expect(result.provider).toBe("grep");
		expect(result.total).toBe(100);
		expect(result.timeMs).toBe(42);
		expect(result.sources).toHaveLength(1);

		const source = result.sources[0];
		expect(source.title).toBe("org/repo: src/index.ts");
		expect(source.url).toBe("https://github.com/org/repo/blob/main/src/index.ts#L10");
		expect(source.branch).toBe("main");
		expect(source.matchCount).toBe(5);
		expect(source.lineNumbers).toEqual([10]);
		expect(source.snippet).toBe("const x = 1;");
	});

	it("defaults branch to HEAD when not provided", async () => {
		mockFetch({
			hits: { total: 1, hits: [{ repo: "a/b", path: "f.ts", content: { snippet: "" } }] },
		});

		const result = await provider.search({ query: "x" });
		expect(result.sources[0].url).toContain("/blob/HEAD/");
	});

	it("extracts line numbers from data-line attributes", async () => {
		const snippet = [
			'<table class="highlight-table">',
			'<tr data-line="5"><td><div class="lineno">5</div></td><td><div class="highlight"><pre>line5</pre></div></td></tr>',
			'<tr data-line="6"><td><div class="lineno">6</div></td><td><div class="highlight"><pre>line6</pre></div></td></tr>',
			'<tr data-line="10"><td><div class="lineno">10</div></td><td><div class="highlight"><pre>line10</pre><div class="jump"></div></div></td></tr>',
			'<tr data-line="20"><td><div class="lineno">20</div></td><td><div class="highlight"><pre>line20</pre></div></td></tr>',
			"</table>",
		].join("");

		mockFetch({
			hits: { total: 1, hits: [{ repo: "a/b", path: "f.ts", branch: "main", content: { snippet } }] },
		});

		const result = await provider.search({ query: "x" });
		const source = result.sources[0];
		expect(source.lineNumbers).toEqual([5, 6, 10, 20]);
		expect(source.snippet).toBe("line5\nline6\nline10\nline20");
		expect(source.url).toBe("https://github.com/a/b/blob/main/f.ts#L5");
	});

	it("handles jump divs (line gaps) correctly", async () => {
		const snippet = [
			'<table class="highlight-table">',
			'<tr data-line="1"><td><div class="lineno">1</div></td><td><div class="highlight"><pre>first</pre><div class="jump"></div></div></td></tr>',
			'<tr data-line="50"><td><div class="lineno">50</div></td><td><div class="highlight"><pre>after gap</pre></div></td></tr>',
			"</table>",
		].join("");

		mockFetch({
			hits: { total: 1, hits: [{ repo: "a/b", path: "f.ts", content: { snippet } }] },
		});

		const result = await provider.search({ query: "x" });
		expect(result.sources[0].lineNumbers).toEqual([1, 50]);
		expect(result.sources[0].snippet).toBe("first\nafter gap");
	});

	it("strips HTML entities and tags from snippets", async () => {
		const snippet =
			'<table class="highlight-table"><tr data-line="1"><td><div class="lineno">1</div></td><td><div class="highlight"><pre><span class="kd">const</span> x = <mark>a</mark> &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39;</pre></div></td></tr></table>';

		mockFetch({
			hits: { total: 1, hits: [{ repo: "a/b", path: "f.ts", content: { snippet } }] },
		});

		const result = await provider.search({ query: "x" });
		expect(result.sources[0].snippet).toBe("const x = a & <b> \"c\" 'd'");
	});

	it("returns facets (top languages and repos)", async () => {
		mockFetch({
			hits: { total: 0, hits: [] },
			facets: {
				lang: {
					buckets: [
						{ val: "TypeScript", count: 100 },
						{ val: "JavaScript", count: 80 },
						{ val: "Python", count: 60 },
						{ val: "Go", count: 40 },
						{ val: "Rust", count: 20 },
						{ val: "Java", count: 10 },
					],
				},
				repo: {
					buckets: [
						{ val: "vercel/next.js", count: 50 },
						{ val: "facebook/react", count: 40 },
						{ val: "denoland/deno", count: 30 },
						{ val: "rust-lang/rust", count: 20 },
						{ val: "golang/go", count: 10 },
						{ val: "extra/repo", count: 5 },
					],
				},
			},
		});

		const result = await provider.search({ query: "x" });
		expect(result.topLanguages).toHaveLength(5);
		expect(result.topRepos).toHaveLength(5);
		expect(result.topLanguages![0].val).toBe("TypeScript");
		expect(result.topRepos![4].val).toBe("golang/go");
	});

	it("respects limit parameter", async () => {
		mockFetch({
			hits: {
				total: 100,
				hits: Array.from({ length: 20 }, (_, i) => ({
					repo: "a/b",
					path: `file${i}.ts`,
					content: { snippet: "" },
				})),
			},
		});

		const result = await provider.search({ query: "x", limit: 3 });
		expect(result.sources).toHaveLength(3);
	});

	it("throws on non-OK response", async () => {
		globalThis.fetch = mock(() => Promise.resolve(new Response("rate limited", { status: 429 }))) as any;

		await expect(provider.search({ query: "x" })).rejects.toThrow("grep.app error (429)");
	});

	it("handles empty response gracefully", async () => {
		mockFetch({});

		const result = await provider.search({ query: "nonexistent" });
		expect(result.sources).toHaveLength(0);
		expect(result.total).toBeUndefined();
	});

	it("handles missing content/snippet gracefully", async () => {
		mockFetch({
			hits: {
				total: 1,
				hits: [{ repo: "a/b", path: "f.ts" }],
			},
		});

		const result = await provider.search({ query: "x" });
		expect(result.sources[0].snippet).toBeUndefined();
		expect(result.sources[0].lineNumbers).toBeUndefined();
	});
});
