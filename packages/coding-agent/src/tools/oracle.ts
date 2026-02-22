import { Type } from "@sinclair/typebox";
import oracleDescription from "../prompts/tools/oracle.md" with { type: "text" };
import { createSubagentTool } from "./subagent-tool";

const schema = Type.Object({
	task: Type.String({
		description:
			"The task or question for the Oracle. Be specific about what kind of guidance, review, or planning you need.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Background about the current situation, what you've tried, or relevant information.",
		}),
	),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "File paths the Oracle should examine as part of its analysis.",
		}),
	),
});

function buildTask(p: Record<string, unknown>): string {
	let task = p.task as string;
	if (p.context) task += `\n\n## Context\n${p.context}`;
	const files = p.files as string[] | undefined;
	if (files?.length) task += `\n\n## Files to examine\n${files.map(f => `- ${f}`).join("\n")}`;
	return task;
}

export const OracleTool = createSubagentTool({
	name: "oracle",
	label: "Oracle",
	agent: "oracle",
	schema,
	descriptionTemplate: oracleDescription,
	progressText: "Consulting oracle...",
	tmpPrefix: "arc-oracle-",
	buildTask,
	buildDescription: p => `Oracle: ${(p.task as string).slice(0, 60)}`,
});
