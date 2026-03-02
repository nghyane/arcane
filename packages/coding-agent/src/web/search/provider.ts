import { AnthropicProvider } from "./providers/anthropic";
import type { SearchProvider } from "./providers/base";
import { BraveProvider } from "./providers/brave";
import { CodexProvider } from "./providers/codex";
import { ExaProvider } from "./providers/exa";
import { GeminiProvider } from "./providers/gemini";
import { JinaProvider } from "./providers/jina";
import { KagiProvider } from "./providers/kagi";
import { KimiProvider } from "./providers/kimi";
import { PerplexityProvider } from "./providers/perplexity";
import { SyntheticProvider } from "./providers/synthetic";
import { ZaiProvider } from "./providers/zai";
import type { SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
	exa: new ExaProvider(),
	brave: new BraveProvider(),
	jina: new JinaProvider(),
	kagi: new KagiProvider(),
	perplexity: new PerplexityProvider(),
	kimi: new KimiProvider(),
	zai: new ZaiProvider(),
	anthropic: new AnthropicProvider(),
	gemini: new GeminiProvider(),
	codex: new CodexProvider(),
	synthetic: new SyntheticProvider(),
} as const;

export const SEARCH_PROVIDER_ORDER: SearchProviderId[] = [
	"perplexity",
	"exa",
	"brave",
	"jina",
	"kagi",
	"kimi",
	"anthropic",
	"gemini",
	"codex",
	"zai",
	"synthetic",
];

export function getSearchProvider(provider: SearchProviderId): SearchProvider {
	return SEARCH_PROVIDERS[provider];
}

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/** Determine which providers are configured (priority: Perplexity → Exa → Brave → Jina → Kimi → Anthropic → Gemini → Codex → Z.AI → Synthetic) */
export async function resolveProviderChain(
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): Promise<SearchProvider[]> {
	const order: SearchProviderId[] =
		preferredProvider !== "auto"
			? [preferredProvider, ...SEARCH_PROVIDER_ORDER.filter(id => id !== preferredProvider)]
			: SEARCH_PROVIDER_ORDER;

	const checks = await Promise.all(
		order.map(async id => ({
			provider: getSearchProvider(id),
			available: await getSearchProvider(id).isAvailable(),
		})),
	);

	return checks.filter(c => c.available).map(c => c.provider);
}
