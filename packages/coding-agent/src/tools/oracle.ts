import { Type } from "@sinclair/typebox";
import type { SubagentConfig } from "./subagent-tool";

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
	const parts: string[] = [p.task as string];
	if (p.context) parts.push(`\nContext: ${p.context}`);
	const files = p.files as string[] | undefined;
	if (files?.length) parts.push(`\nFiles to examine:\n${files.map(f => `- ${f}`).join("\n")}`);
	return parts.join("\n");
}

export const oracleConfig: SubagentConfig<typeof schema.properties> = {
	name: "oracle",
	label: "Oracle",
	agent: "oracle",
	schema,
	progressText: "Analyzing...",
	tmpPrefix: "arc-oracle-",
	buildTask,
	buildDescription: p => (p.task as string).slice(0, 80),
	buildContextLine: p => {
		const parts: string[] = [];
		if (p.context) parts.push(`Context: ${String(p.context).split("\n")[0].slice(0, 40)}`);
		const files = p.files as string[] | undefined;
		if (files?.length) parts.push(`${files.length} file${files.length > 1 ? "s" : ""}`);
		return parts.length > 0 ? parts.join(" · ") : null;
	},
	toolDescription: [
		"Senior engineering advisor with deep reasoning. Returns single comprehensive response — no follow-ups.",
		"WHEN TO USE: Only for complex tasks requiring deep analysis, planning, or debugging across multiple files. Pass files for it to examine, context for background.",
		"WHEN NOT TO USE: Simple questions answerable by reading code; tasks you can do directly.",
		"Treat its response as advisory — do independent investigation after, then act.",
	].join(" "),
};
