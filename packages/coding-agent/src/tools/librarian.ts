import { Type } from "@sinclair/typebox";
import type { SubagentConfig } from "./subagent-tool";

const schema = Type.Object({
	query: Type.String({
		description:
			"Your question about the codebase or repository. Be specific about what you want to understand or explore.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Background about what you're trying to achieve.",
		}),
	),
});

function buildTask(p: Record<string, unknown>): string {
	const parts: string[] = [p.query as string];
	if (p.context) parts.push(`\nContext: ${p.context}`);
	return parts.join("\n");
}

export const librarianConfig: SubagentConfig<typeof schema.properties> = {
	name: "librarian",
	label: "Librarian",
	agent: "librarian",
	schema,
	progressText: "Exploring repositories...",
	tmpPrefix: "arc-librarian-",
	buildTask,
	buildDescription: p => (p.query as string).slice(0, 80),
	buildContextLine: p => {
		if (!p.context) return null;
		return `Context: ${String(p.context).split("\n")[0].slice(0, 60)}`;
	},
	toolDescription: "Explore remote GitHub repositories — cross-repo architecture, code search, history",
};
