import { $env, logger } from "@nghyane/arcane-utils";
import { $ } from "bun";

// =============================================================================
// Types
// =============================================================================

interface GitHubResponse<T = unknown> {
	data: T;
	ok: boolean;
	status: number;
	rateLimit?: RateLimitInfo;
}

interface RateLimitInfo {
	remaining: number;
	limit: number;
	reset: number;
}

interface RequestOptions {
	timeout?: number;
	signal?: AbortSignal;
	accept?: string;
	mediaType?: string;
}

interface CacheEntry {
	etag: string;
	data: unknown;
	timestamp: number;
}

// =============================================================================
// Auth
// =============================================================================

let cachedToken: string | undefined;
let tokenResolved = false;

async function resolveToken(): Promise<string | undefined> {
	if (tokenResolved) return cachedToken;
	tokenResolved = true;

	// Env vars first
	const envToken = $env.GITHUB_TOKEN || $env.GH_TOKEN;
	if (envToken) {
		cachedToken = envToken;
		return cachedToken;
	}

	// Fallback: gh auth token
	if (Bun.which("gh")) {
		try {
			const result = await $`gh auth token`.quiet().nothrow();
			if (result.exitCode === 0) {
				const token = result.text().trim();
				if (token) {
					cachedToken = token;
					return cachedToken;
				}
			}
		} catch {
			// gh not authenticated
		}
	}

	return undefined;
}

// =============================================================================
// ETag Cache
// =============================================================================

const etagCache = new Map<string, CacheEntry>();
const CACHE_MAX_SIZE = 200;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(endpoint: string, mediaType?: string): string {
	return mediaType ? `${endpoint}::${mediaType}` : endpoint;
}

function pruneCache(): void {
	if (etagCache.size <= CACHE_MAX_SIZE) return;
	const now = Date.now();
	for (const [key, entry] of etagCache) {
		if (now - entry.timestamp > CACHE_TTL_MS) {
			etagCache.delete(key);
		}
	}
	// If still too large, remove oldest
	if (etagCache.size > CACHE_MAX_SIZE) {
		const entries = [...etagCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
		const toRemove = entries.slice(0, etagCache.size - CACHE_MAX_SIZE);
		for (const [key] of toRemove) {
			etagCache.delete(key);
		}
	}
}

// =============================================================================
// Core Request
// =============================================================================

const RETRY_STATUS_CODES = new Set([429, 502, 503]);
const MAX_RETRIES = 3;

async function request<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<GitHubResponse<T>> {
	const { timeout = 30, signal } = options;
	const token = await resolveToken();

	const headers: Record<string, string> = {
		Accept: options.accept ?? "application/vnd.github.v3+json",
		"User-Agent": "arcane-github-tool/1.0",
	};

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	if (options.mediaType) {
		headers.Accept = options.mediaType;
	}

	const cacheKey = getCacheKey(endpoint, options.mediaType);
	const cached = etagCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		headers["If-None-Match"] = cached.etag;
	}

	const url = endpoint.startsWith("https://") ? endpoint : `https://api.github.com${endpoint}`;

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

			// Combine with external signal
			if (signal?.aborted) {
				clearTimeout(timeoutId);
				return { data: null as T, ok: false, status: 0 };
			}

			const abortHandler = () => controller.abort();
			signal?.addEventListener("abort", abortHandler, { once: true });

			try {
				const response = await fetch(url, {
					headers,
					signal: controller.signal,
				});

				clearTimeout(timeoutId);
				signal?.removeEventListener("abort", abortHandler);

				// Parse rate limit
				const rateLimit: RateLimitInfo = {
					remaining: parseInt(response.headers.get("x-ratelimit-remaining") ?? "-1", 10),
					limit: parseInt(response.headers.get("x-ratelimit-limit") ?? "-1", 10),
					reset: parseInt(response.headers.get("x-ratelimit-reset") ?? "0", 10),
				};

				if (rateLimit.remaining >= 0 && rateLimit.remaining < 10) {
					logger.warn("GitHub API rate limit low", {
						remaining: rateLimit.remaining,
						reset: new Date(rateLimit.reset * 1000).toISOString(),
					});
				}

				// 304 Not Modified — return cached data
				if (response.status === 304 && cached) {
					cached.timestamp = Date.now();
					return { data: cached.data as T, ok: true, status: 304, rateLimit };
				}

				// Retry on transient errors
				const isRateLimited =
					response.status === 429 ||
					(response.status === 403 && (rateLimit.remaining === 0 || response.headers.has("retry-after")));
				const isTransient = RETRY_STATUS_CODES.has(response.status) || isRateLimited;

				if (isTransient && attempt < MAX_RETRIES) {
					await response.text().catch(() => {});
					const retryAfter = response.headers.get("retry-after");
					const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : Number.NaN;
					const waitMs = Number.isFinite(retrySeconds)
						? retrySeconds * 1000
						: Math.min(1000 * 2 ** attempt, 10_000);

					if (isRateLimited && rateLimit.remaining === 0) {
						const resetMs = rateLimit.reset * 1000 - Date.now();
						if (resetMs > 30_000) {
							return { data: null as T, ok: false, status: response.status, rateLimit };
						}
						await Bun.sleep(Math.max(resetMs, 1000));
					} else {
						await Bun.sleep(waitMs);
					}
					continue;
				}

				if (!response.ok) {
					return { data: null as T, ok: false, status: response.status, rateLimit };
				}

				const wantsRaw = options.mediaType !== undefined;
				const data = (wantsRaw ? await response.text() : await response.json()) as T;

				// Cache with ETag
				const etag = response.headers.get("etag");
				if (etag) {
					etagCache.set(cacheKey, { etag, data, timestamp: Date.now() });
					pruneCache();
				}

				return { data, ok: true, status: response.status, rateLimit };
			} catch (err) {
				clearTimeout(timeoutId);
				signal?.removeEventListener("abort", abortHandler);
				throw err;
			}
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRIES) {
				await Bun.sleep(1000 * 2 ** attempt);
			}
		}
	}

	logger.error("GitHub API request failed", { endpoint, error: lastError?.message });
	return { data: null as T, ok: false, status: 0 };
}

// =============================================================================
// Paginated Request
// =============================================================================

async function requestPaginated<T>(
	endpoint: string,
	options: RequestOptions & { perPage?: number; maxPages?: number } = {},
): Promise<GitHubResponse<T[]>> {
	const perPage = options.perPage ?? 30;
	const maxPages = options.maxPages ?? 3;
	const separator = endpoint.includes("?") ? "&" : "?";
	const allData: T[] = [];

	for (let page = 1; page <= maxPages; page++) {
		const paginatedEndpoint = `${endpoint}${separator}per_page=${perPage}&page=${page}`;
		const response = await request<T[]>(paginatedEndpoint, options);

		if (!response.ok) {
			if (allData.length > 0) {
				return { data: allData, ok: true, status: response.status, rateLimit: response.rateLimit };
			}
			return response;
		}

		allData.push(...response.data);

		// No more pages
		if (response.data.length < perPage) break;
	}

	return { data: allData, ok: true, status: 200 };
}

// =============================================================================
// Raw content request (for file contents)
// =============================================================================

async function requestRaw(endpoint: string, options: RequestOptions = {}): Promise<GitHubResponse<string>> {
	return request<string>(endpoint, {
		...options,
		mediaType: "application/vnd.github.v3.raw",
	});
}

// =============================================================================
// Public API
// =============================================================================

export const githubClient = {
	request,
	requestPaginated,
	requestRaw,
	resolveToken,

	clearCache(): void {
		etagCache.clear();
	},

	isAuthenticated(): Promise<boolean> {
		return resolveToken().then(t => t !== undefined);
	},
} as const;

export type { GitHubResponse, RateLimitInfo, RequestOptions };
