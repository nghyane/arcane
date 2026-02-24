import { Type } from "@sinclair/typebox";
import { createSubagentTool } from "./subagent-tool";

const schema = Type.Object({
	query: Type.String({
		description:
			"The search query describing what to find. Be specific — include technical terms, file types, or expected code patterns.",
	}),
});

export const ExploreTool = createSubagentTool({
	name: "explore",
	label: "Explore",
	agent: "explore",
	schema,
	progressText: "Searching codebase...",
	tmpPrefix: "arc-explore-",
	buildTask: p => p.query as string,
	buildDescription: p => `Explore: ${(p.query as string).slice(0, 60)}`,
	toolDescription: "Search local codebase by concept or behavior — spawns a read-only scout agent",
	passContext: false,
});
