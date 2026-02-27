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
		"Smart codebase scout — locates logic by conceptual description, chains grep/find/read internally.",
		'WHEN TO USE: Locate code by behavior or concept; chain multiple greps; trace flows; find code by behavior (e.g. "where do we validate auth headers?"). Spawn multiple explores in parallel for different concepts.',
		"WHEN NOT TO USE: Exact symbol lookup (use lsp); exact text match (use grep); remote repos (use librarian).",
	].join(" "),
	passContext: false,
};
