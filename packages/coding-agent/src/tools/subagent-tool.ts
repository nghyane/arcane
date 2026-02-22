/**
 * Generic subagent tool factory.
 *
 * All standalone subagent tools (explore, oracle, librarian, code_review)
 * share identical execution logic. This factory eliminates the boilerplate.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import { Snowflake } from "@nghyane/arcane-utils";
import type { TObject, TProperties } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { isDefaultModelAlias } from "../config/model-resolver";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { Theme } from "../modes/theme/theme";
import { getBundledAgent } from "../task/agents";
import { runAgent } from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentProgress, TaskToolDetails } from "../task/types";

export interface SubagentToolConfig<T extends TProperties> {
	/** Tool name exposed to the model */
	name: string;
	/** Display label in TUI */
	label: string;
	/** Bundled agent name to invoke */
	agent: string;
	/** TypeBox schema for parameters */
	schema: TObject<T>;
	/** Raw .md template for tool description */
	descriptionTemplate: string;
	/** Progress message shown during execution */
	progressText: string;
	/** Temp directory prefix */
	tmpPrefix: string;
	/** Build the task string from parsed params */
	buildTask: (params: Record<string, unknown>) => string;
	/** Build the description for runAgent (shown in TUI) */
	buildDescription: (params: Record<string, unknown>) => string;
	/** Whether to pass compact conversation context to subagent (default: true) */
	passContext?: boolean;
}

export function createSubagentTool<T extends TProperties>(
	config: SubagentToolConfig<T>,
): new (
	session: ToolSession,
) => AgentTool<TObject<T>, TaskToolDetails, Theme> {
	const {
		name,
		label,
		agent: agentName,
		schema,
		descriptionTemplate,
		progressText,
		tmpPrefix,
		buildTask,
		buildDescription,
		passContext = true,
	} = config;

	const description = renderPromptTemplate(descriptionTemplate);

	return class SubagentTool implements AgentTool<TObject<T>, TaskToolDetails, Theme> {
		readonly name = name;
		readonly label = label;
		readonly parameters = schema;
		readonly description = description;

		constructor(private readonly session: ToolSession) {}

		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		): Promise<AgentToolResult<TaskToolDetails>> {
			const startTime = Date.now();
			const agent = getBundledAgent(agentName);
			if (!agent) {
				return {
					content: [{ type: "text", text: `${label} agent not found.` }],
					details: { results: [], totalDurationMs: 0 },
				};
			}

			const effectiveAgentModel = isDefaultModelAlias(agent.model) ? undefined : agent.model;
			const modelOverride =
				effectiveAgentModel ?? this.session.getActiveModelString?.() ?? this.session.getModelString?.();

			const task = buildTask(params);
			const sessionFile = this.session.getSessionFile();
			const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
			const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `${tmpPrefix}${Snowflake.next()}`);
			const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

			try {
				await fs.mkdir(effectiveArtifactsDir, { recursive: true });

				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				const [id] = await outputManager.allocateBatch([label]);

				const emitProgress = (progress: AgentProgress) => {
					onUpdate?.({
						content: [{ type: "text", text: progressText }],
						details: { results: [], totalDurationMs: Date.now() - startTime, progress: [progress] },
					});
				};

				let contextFilePath: string | undefined;
				if (passContext) {
					const compactContext = this.session.getCompactContext?.();
					if (compactContext) {
						contextFilePath = path.join(effectiveArtifactsDir, "context.md");
						await Bun.write(contextFilePath, compactContext);
					}
				}

				const result = await runAgent({
					cwd: this.session.cwd,
					agent,
					task,
					description: buildDescription(params),
					index: 0,
					id,
					taskDepth: this.session.taskDepth ?? 0,
					modelOverride,
					sessionFile,
					persistArtifacts: !!artifactsDir,
					artifactsDir: effectiveArtifactsDir,
					contextFile: contextFilePath,
					enableLsp: false,
					signal,
					onProgress: emitProgress,
					authStorage: this.session.authStorage,
					modelRegistry: this.session.modelRegistry,
					settings: this.session.settings,
					contextFiles: this.session.contextFiles,
					skills: this.session.skills,
					promptTemplates: this.session.promptTemplates,
					mcpManager: this.session.mcpManager,
				});

				if (tempArtifactsDir) {
					await fs.rm(tempArtifactsDir, { recursive: true, force: true });
				}

				const totalDuration = Date.now() - startTime;
				const output = result.output.trim() || result.stderr.trim() || "(no output)";

				return {
					content: [{ type: "text", text: output }],
					details: {
						results: [result],
						totalDurationMs: totalDuration,
						usage: result.usage,
					},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `${label} failed: ${err}` }],
					details: { results: [], totalDurationMs: Date.now() - startTime },
				};
			}
		}
	};
}
