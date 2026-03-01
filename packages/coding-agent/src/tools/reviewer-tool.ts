import { Type } from "@sinclair/typebox";
import type { SubagentConfig } from "./subagent-tool";

const schema = Type.Object({
	diff_description: Type.String({ description: "Description of the diff or change to review" }),
	files: Type.Optional(Type.Array(Type.String(), { description: "Specific files to focus the review on" })),
	instructions: Type.Optional(Type.String({ description: "Additional review instructions" })),
});

function buildTask(p: Record<string, unknown>): string {
	const parts: string[] = [`Review: ${p.diff_description}`];
	const files = p.files as string[] | undefined;
	if (files?.length) parts.push(`\nFocus on files:\n${files.map(f => `- ${f}`).join("\n")}`);
	if (p.instructions) parts.push(`\nAdditional instructions: ${p.instructions}`);
	return parts.join("\n");
}

export const reviewerConfig: SubagentConfig<typeof schema.properties> = {
	name: "code_review",
	label: "Code Review",
	agent: "reviewer",
	schema,
	progressText: "Reviewing code...",
	tmpPrefix: "arc-review-",
	buildTask,
	buildDescription: p => String(p.diff_description ?? "").slice(0, 80),
	buildContextLine: p => {
		const parts: string[] = [];
		const files = p.files as string[] | undefined;
		if (files?.length) parts.push(`${files.length} file${files.length > 1 ? "s" : ""}`);
		if (p.instructions) parts.push(String(p.instructions).slice(0, 50));
		return parts.length > 0 ? parts.join(" · ") : null;
	},
	toolDescription: [
		"Code review specialist — spawns reviewer agent on a diff.",
		'Pass diff_description (e.g. "uncommitted changes", "last commit"), optionally files and instructions.',
	].join(" "),
	passContext: false,
};
