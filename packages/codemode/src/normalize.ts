/**
 * Normalize LLM-generated code into a valid async arrow function.
 *
 * Only strips markdown fences (a common LLM output artifact).
 * If the result is not an async arrow function, throws immediately —
 * the LLM is expected to follow the prompt format.
 */

const ASYNC_ARROW_RE = /^\s*async\s*\(.*?\)\s*=>/s;
const FENCE_RE = /^```(?:jsx?|tsx?|javascript|typescript)?\s*\n([\s\S]*?)\n\s*```\s*$/;

function stripFences(code: string): string {
	const match = FENCE_RE.exec(code);
	return match ? match[1] : code;
}

export function normalizeCode(code: string): string {
	const trimmed = stripFences(code.trim()).trim();

	if (!trimmed) {
		throw new Error("Code Mode received empty code from the model");
	}

	if (!ASYNC_ARROW_RE.test(trimmed)) {
		const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
		throw new Error(`Code Mode expected an async arrow function, got:\n${preview}`);
	}

	return trimmed;
}
