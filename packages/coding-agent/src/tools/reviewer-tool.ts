import { Type } from "@sinclair/typebox";
import type { SubagentConfig } from "./subagent-tool";

const schema = Type.Object({
	diff_description: Type.String({
		description:
			'A description or command identifying the diff to review. Examples: "uncommitted changes", "last commit", "PR #42", "changes against main branch".',
	}),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific file paths to focus the review on. If omitted, all changed files are reviewed.",
		}),
	),
	instructions: Type.Optional(
		Type.String({
			description:
				'Additional guidance for the reviewer. Examples: "Focus on error handling", "Check for race conditions".',
		}),
	),
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
	buildDescription: p => (p.diff_description as string).slice(0, 80),
	toolDescription: "Review code changes for correctness, style, and potential issues",
	allowedTools: ["read", "grep", "find", "lsp", "bash", "github"],
};
