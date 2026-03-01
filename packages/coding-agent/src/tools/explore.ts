import { Type } from "@sinclair/typebox";
import type { SubagentConfig } from "./subagent-tool";

const schema = Type.Object({
	query: Type.String({ description: "What to search for in the codebase" }),
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
		"Intelligently search the codebase. Use for complex, multi-step search tasks where you need to find code based on functionality or concepts rather than exact matches. Chains multiple grep/find/read calls internally.",
		'WHEN TO USE: Locate code by behavior or concept; chain multiple searches; correlate several areas of the codebase; filter broad terms ("config", "cache", "auth") by context; answer questions like "Where do we validate JWT headers?".',
		"WHEN NOT TO USE: Exact file path known (use read tool); specific symbol lookup (use lsp tool); single exact text match (use grep tool); remote repos (use librarian tool).",
		'PROMPTING: Be specific and goal-oriented. Name concrete artifacts, patterns, or APIs to narrow scope. State explicit success criteria so the agent knows when to stop. Good: "Find all JWT verification calls, return file paths and line numbers." Bad: "auth search".',
	].join(" "),
	passContext: false,
};
