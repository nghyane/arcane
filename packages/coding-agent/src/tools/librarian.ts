import { Type } from "@sinclair/typebox";
import librarianDescription from "../prompts/codemode/librarian.md" with { type: "text" };
import { createSubagentTool } from "./subagent-tool";

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
	let task = p.query as string;
	if (p.context) task += `\n\nContext: ${p.context}`;
	return task;
}

export const LibrarianTool = createSubagentTool({
	name: "librarian",
	label: "Librarian",
	agent: "librarian",
	schema,
	descriptionTemplate: librarianDescription,
	progressText: "Exploring repositories...",
	tmpPrefix: "arc-librarian-",
	buildTask,
	buildDescription: p => `Librarian: ${(p.query as string).slice(0, 60)}`,
});
