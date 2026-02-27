import { Type } from "@sinclair/typebox";
import type { SubagentConfig } from "./subagent-tool";

const schema = Type.Object({
	query: Type.String({
		description:
			"Your question about the codebase. Be specific — include technical terms, file types, or expected code patterns.",
	}),
});

export const exploreConfig: SubagentConfig<typeof schema.properties> = {
	name: "explore",
	label: "Explore",
	agent: "explore",
	schema,
	progressText: "Searching codebase...",
	tmpPrefix: "arc-explore-",
	buildTask: p => p.query as string,
	buildDescription: p => (p.query as string).slice(0, 80),
	toolDescription: [
		"Primary codebase search tool — locates logic by conceptual description, chains grep/find/read internally. Output is shown to the user, so do not repeat or re-search the same topic.",
		'WHEN TO USE: Gathering context about the codebase; locating code by behavior or concept; chaining multiple searches; tracing flows across files; broad terms like "config", "cache", "auth" that need context filtering. Prefer this over grep for context gathering.',
		"WHEN NOT TO USE: Exact symbol lookup (use lsp); single exact text match (use grep); remote repos (use librarian).",
		'PROMPTING: Name concrete artifacts/APIs, state success criteria. Good: "Find all JWT verification calls, return file paths and line numbers." Bad: "auth search".',
	].join(" "),
	passContext: false,
};
