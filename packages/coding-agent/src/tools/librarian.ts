import { Type } from "@sinclair/typebox";
import type { SubagentConfig } from "./subagent-tool";

const schema = Type.Object({
	query: Type.String(),
	context: Type.Optional(Type.String()),
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
	toolDescription: [
		"Explore remote GitHub repositories — cross-repo code search, reading files/PRs/issues, tracing commit history, finding implementation examples across public repos.",
		"WHEN TO USE: Cross-repo code search; reading remote files; tracing PRs/issues/commits; finding how other projects solve similar problems.",
		"WHEN NOT TO USE: Local codebase search (use explore/grep); quick single-file/issue lookups (use github directly).",
	].join(" "),
};
