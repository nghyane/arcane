import { Type } from "@sinclair/typebox";
import analyzeFilePrompt from "../../../commit/agentic/prompts/analyze-file.md" with { type: "text" };
import type { CommitAgentState } from "../../../commit/agentic/state";
import type { NumstatEntry } from "../../../commit/types";
import type { ModelRegistry } from "../../../config/model-registry";
import { renderPromptTemplate } from "../../../config/prompt-templates";
import type { Settings } from "../../../config/settings";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import type { AuthStorage } from "../../../session/auth-storage";
import { getBundledAgent } from "../../../task/agents";
import { runAgent } from "../../../task/executor";

const analyzeFileSchema = Type.Object({
	file: Type.String({ description: "File path to analyze" }),
	goal: Type.Optional(Type.String({ description: "Optional analysis focus" })),
});

export function createAnalyzeFileTool(options: {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	state: CommitAgentState;
}): CustomTool<typeof analyzeFileSchema> {
	return {
		name: "analyze_file",
		label: "Analyze File",
		description: "Spawn a quick_task agent to analyze a single file.",
		parameters: analyzeFileSchema,
		async execute(_toolCallId, params, _onUpdate, ctx, signal) {
			const numstat = options.state.overview?.numstat ?? [];
			const relatedFiles = buildRelatedFiles(params.file, numstat);
			const prompt = renderPromptTemplate(analyzeFilePrompt, {
				file: params.file,
				goal: params.goal,
				related_files: relatedFiles,
			});

			const agent = getBundledAgent("quick_task");
			if (!agent) {
				return {
					content: [{ type: "text", text: "quick_task agent not found." }],
					details: {},
				};
			}

			try {
				const result = await runAgent({
					cwd: options.cwd,
					agent,
					task: prompt,
					description: `Analyze ${params.file}`,
					index: 0,
					id: "AnalyzeFile",
					sessionFile: ctx.sessionManager.getSessionFile() ?? null,
					persistArtifacts: false,
					enableLsp: false,
					isSubagent: true,
					signal,
					authStorage: options.authStorage,
					modelRegistry: options.modelRegistry,
					settings: options.settings,
				});

				const output = result.output.trim();
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: {},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Analysis failed";
				return {
					content: [{ type: "text", text: message }],
					details: {},
				};
			}
		},
	};
}

function buildRelatedFiles(currentFile: string, numstat: NumstatEntry[]): string | undefined {
	const others = numstat.filter(e => e.path !== currentFile);
	if (others.length === 0) return undefined;

	const lines = others.map(e => {
		const changes = e.additions + e.deletions;
		return changes > 0 ? `- ${e.path} (+${e.additions}/-${e.deletions})` : `- ${e.path}`;
	});

	return lines.join("\n");
}
