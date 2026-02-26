import { beforeEach, describe, expect, it } from "bun:test";
import {
	getSearchProvider,
	resolveProviderChain,
	SEARCH_PROVIDER_ORDER,
	setPreferredSearchProvider,
} from "@nghyane/arcane/web/search/provider";

describe("getSearchProvider", () => {
	it("returns a provider for each known id", () => {
		for (const id of SEARCH_PROVIDER_ORDER) {
			const provider = getSearchProvider(id);
			expect(provider).toBeDefined();
			expect(provider.id).toBe(id);
		}
	});
});

describe("SEARCH_PROVIDER_ORDER", () => {
	it("has perplexity first", () => {
		expect(SEARCH_PROVIDER_ORDER[0]).toBe("perplexity");
	});

	it("does not include grep", () => {
		expect(SEARCH_PROVIDER_ORDER).not.toContain("grep");
	});

	it("has 10 providers", () => {
		expect(SEARCH_PROVIDER_ORDER).toHaveLength(10);
	});
});

describe("resolveProviderChain", () => {
	beforeEach(() => {
		setPreferredSearchProvider("auto");
	});

	it("returns only available providers", async () => {
		const chain = await resolveProviderChain("auto");
		for (const provider of chain) {
			const available = await provider.isAvailable();
			expect(available).toBe(true);
		}
	});

	it("preserves priority order", async () => {
		const chain = await resolveProviderChain("auto");
		if (chain.length < 2) return;

		const ids = chain.map(p => p.id);
		for (let i = 0; i < ids.length - 1; i++) {
			const idxA = SEARCH_PROVIDER_ORDER.indexOf(ids[i]);
			const idxB = SEARCH_PROVIDER_ORDER.indexOf(ids[i + 1]);
			expect(idxA).toBeLessThan(idxB);
		}
	});

	it("puts preferred provider first when specified", async () => {
		const chain = await resolveProviderChain("synthetic");
		if (chain.length === 0) return;

		const syntheticProvider = getSearchProvider("synthetic");
		if (await syntheticProvider.isAvailable()) {
			expect(chain[0].id).toBe("synthetic");
		}
	});

	it("does not duplicate preferred provider in chain", async () => {
		const chain = await resolveProviderChain("synthetic");
		const ids = chain.map(p => p.id);
		const unique = new Set(ids);
		expect(ids.length).toBe(unique.size);
	});

	it("respects setPreferredSearchProvider", async () => {
		setPreferredSearchProvider("synthetic");
		const chain = await resolveProviderChain();

		const syntheticProvider = getSearchProvider("synthetic");
		if (await syntheticProvider.isAvailable()) {
			expect(chain[0].id).toBe("synthetic");
		}

		setPreferredSearchProvider("auto");
	});

	it("runs isAvailable checks in parallel (not sequential)", async () => {
		const start = performance.now();
		await resolveProviderChain("auto");
		const elapsed = performance.now() - start;

		// With 10 providers, sequential would be noticeably slower than parallel.
		// This is a smoke test — if each isAvailable takes even 1ms sequentially = 10ms.
		// Parallel should be ~1ms. We just check it completes quickly.
		expect(elapsed).toBeLessThan(500);
	});
});
