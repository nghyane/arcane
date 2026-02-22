import { Type } from "@sinclair/typebox";
import analyzeFilePrompt from "../../../commit/agentic/prompts/analyze-file.md" with { type: "text" };
import type { CommitAgentState } from "../../../commit/agentic/state";
import type { NumstatEntry } from "../../../commit/types";
import type { ModelRegistry } from "../../../config/model-registry";
import { renderPromptTemplate } from "../../../config/prompt-templates";
import type { Settings } from "../../../config/settings";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import type { AuthStorage } from "../../../session/auth-storage";
import { runTaskBatch } from "../../../task/batch";
import { getFilePriority } from "./git-file-diff";

const analyzeFileSchema = Type.Object({
	files: Type.Array(Type.String({ description: "File path" }), { minItems: 1 }),
	goal: Type.Optional(Type.String({ description: "Optional analysis focus" })),
});

export function createAnalyzeFileTool(options: {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	spawns: string;
	state: CommitAgentState;
}): CustomTool<typeof analyzeFileSchema> {
	return {
		name: "analyze_files",
		label: "Analyze Files",
		description: "Spawn quick_task agents to analyze files.",
		parameters: analyzeFileSchema,
		async execute(_toolCallId, params, _onUpdate, ctx, signal) {
			const numstat = options.state.overview?.numstat ?? [];
			const tasks = params.files.map((file, index) => {
				const relatedFiles = formatRelatedFiles(params.files, file, numstat);
				const prompt = renderPromptTemplate(analyzeFilePrompt, {
					file,
					goal: params.goal,
					related_files: relatedFiles,
				});
				return {
					id: `AnalyzeFile${index + 1}`,
					description: `Analyze ${file}`,
					task: prompt,
				};
			});

			try {
				const { results } = await runTaskBatch({
					cwd: options.cwd,
					agentName: "quick_task",
					tasks,
					sessionFile: ctx.sessionManager.getSessionFile() ?? null,
					signal,
					authStorage: options.authStorage,
					modelRegistry: options.modelRegistry,
					settings: options.settings,
				});

				const output = results
					.filter(Boolean)
					.map(r => r!.output.trim())
					.filter(Boolean)
					.join("\n\n---\n\n");

				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: {},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Task batch failed";
				return {
					content: [{ type: "text", text: message }],
					details: {},
				};
			}
		},
	};
}

function inferFileType(path: string): string {
	const priority = getFilePriority(path);
	const lowerPath = path.toLowerCase();

	if (priority === -100) return "binary file";
	if (priority === 10) return "test file";
	if (lowerPath.endsWith(".md") || lowerPath.endsWith(".txt")) return "documentation";
	if (
		lowerPath.endsWith(".json") ||
		lowerPath.endsWith(".yaml") ||
		lowerPath.endsWith(".yml") ||
		lowerPath.endsWith(".toml")
	)
		return "configuration";
	if (priority === 70) return "dependency manifest";
	if (priority === 80) return "script";
	if (priority === 100) return "implementation";

	return "source file";
}

function formatRelatedFiles(files: string[], currentFile: string, numstat: NumstatEntry[]): string | undefined {
	const others = files.filter(file => file !== currentFile);
	if (others.length === 0) return undefined;

	const numstatMap = new Map(numstat.map(entry => [entry.path, entry]));

	const lines = others.map(file => {
		const entry = numstatMap.get(file);
		const fileType = inferFileType(file);
		if (entry) {
			const lineCount = entry.additions + entry.deletions;
			return `- ${file} (${lineCount} lines): ${fileType}`;
		}
		return `- ${file}: ${fileType}`;
	});

	return `OTHER FILES IN THIS CHANGE:\n${lines.join("\n")}`;
}
