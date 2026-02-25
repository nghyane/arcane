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
	toolDescription: "Search local codebase by concept or behavior — spawns a read-only scout agent",
	passContext: false,
	allowedTools: ["read", "grep", "find", "lsp", "bash"],
};
