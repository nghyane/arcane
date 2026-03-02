/**
 * Pure utility functions for retry logic.
 * Stateless — no class dependencies, no side effects.
 */

/**
 * Check if an error message indicates a retryable API error.
 * Matches: overloaded, rate limit, usage limit, 429, 5xx, connection errors.
 */
export function isRetryableErrorMessage(errorMessage: string): boolean {
	return /overloaded|rate.?limit|usage.?limit|too many requests|429|500|502|503|504|service.?unavailable|server error|internal error|connection.?error|unable to connect|fetch failed|retry delay/i.test(
		errorMessage,
	);
}

/**
 * Check if an error message indicates a usage/billing limit (non-transient).
 */
export function isUsageLimitErrorMessage(errorMessage: string): boolean {
	return /usage.?limit|usage_limit_reached|limit_reached|quota.?exhaust/i.test(errorMessage);
}

/**
 * Parse retry-after delay from an error message.
 * Supports: retry-after-ms, retry-after (seconds or HTTP-date), x-ratelimit-reset-ms, x-ratelimit-reset.
 * Returns delay in milliseconds, or undefined if no header found.
 */
export function parseRetryAfterMs(errorMessage: string): number | undefined {
	const now = Date.now();
	const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
	if (retryAfterMsMatch) {
		return Math.max(0, Number(retryAfterMsMatch[1]));
	}

	const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
	if (retryAfterMatch) {
		const value = retryAfterMatch[1];
		const seconds = Number(value);
		if (!Number.isNaN(seconds)) {
			return Math.max(0, seconds * 1000);
		}
		const dateMs = Date.parse(value);
		if (!Number.isNaN(dateMs)) {
			return Math.max(0, dateMs - now);
		}
	}

	const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
	if (resetMsMatch) {
		const resetMs = Number(resetMsMatch[1]);
		if (!Number.isNaN(resetMs)) {
			if (resetMs > 1_000_000_000_000) {
				return Math.max(0, resetMs - now);
			}
			return Math.max(0, resetMs);
		}
	}

	const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
	if (resetMatch) {
		const resetSeconds = Number(resetMatch[1]);
		if (!Number.isNaN(resetSeconds)) {
			if (resetSeconds > 1_000_000_000) {
				return Math.max(0, resetSeconds * 1000 - now);
			}
			return Math.max(0, resetSeconds * 1000);
		}
	}

	return undefined;
}
