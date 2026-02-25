/**
 * Subagent tool system.
 *
 * All standalone subagent tools (explore, oracle, librarian, code_review)
 * share identical execution logic. Each tool is a config object;
 * SubagentTool is the single class that runs them.
 *
 * Rendering is handled externally via the renderer registry (see renderers.ts),
 * not on the tool class itself.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import { Snowflake } from "@nghyane/arcane-utils";
import type { TObject, TProperties } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { isDefaultModelAlias } from "../config/model-resolver";
import type { Theme } from "../modes/theme/theme";
import { getBundledAgent } from "../task/agents";
import { runAgent } from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentProgress, TaskToolDetails } from "../task/types";

export interface SubagentConfig<T extends TProperties = TProperties> {
	/** Tool name exposed to the model */
	name: string;
	/** Display label in TUI */
	label: string;
	/** Bundled agent name to invoke */
	agent: string;
	/** TypeBox schema for parameters */
	schema: TObject<T>;
	/** Progress message shown during execution */
	progressText: string;
	/** Temp directory prefix */
	tmpPrefix: string;
	/** Build the task string from parsed params */
	buildTask: (params: Record<string, unknown>) => string;
	/** Build the short description shown in TUI header */
	buildDescription: (params: Record<string, unknown>) => string;
	/** Whether to pass compact conversation context to subagent (default: true) */
	passContext?: boolean;
	/** One-line tool description for model context */
	toolDescription?: string;
	/** Build optional context line for TUI display (shown below header). Return null to hide. */
	buildContextLine?: (params: Record<string, unknown>) => string | null;
}

export class SubagentTool<T extends TProperties = TProperties>
	implements AgentTool<TObject<T>, TaskToolDetails, Theme>
{
	readonly name: string;
	readonly label: string;
	readonly parameters: TObject<T>;
	description: string;

	#config: SubagentConfig<T>;
	#session: ToolSession;

	constructor(session: ToolSession, config: SubagentConfig<T>) {
		this.#config = config;
		this.#session = session;
		this.name = config.name;
		this.label = config.label;
		this.parameters = config.schema;
		this.description = config.toolDescription ?? "";
	}

	async execute(
		_toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const {
			label,
			agent: agentName,
			progressText,
			tmpPrefix,
			buildTask,
			buildDescription,
			passContext = true,
		} = this.#config;
		const session = this.#session;
		const startTime = Date.now();

		const agent = getBundledAgent(agentName);
		if (!agent) {
			return {
				content: [{ type: "text", text: `${label} agent not found.` }],
				details: { results: [], totalDurationMs: 0 },
			};
		}

		const effectiveAgentModel = isDefaultModelAlias(agent.model) ? undefined : agent.model;
		const modelOverride = effectiveAgentModel ?? session.getActiveModelString?.() ?? session.getModelString?.();

		const task = buildTask(params);
		const sessionFile = session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `${tmpPrefix}${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		try {
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });

			const outputManager =
				session.agentOutputManager ?? new AgentOutputManager(session.getArtifactsDir ?? (() => null));
			const [id] = await outputManager.allocateBatch([label]);

			const emitProgress = (progress: AgentProgress) => {
				onUpdate?.({
					content: [{ type: "text", text: progressText }],
					details: { results: [], totalDurationMs: Date.now() - startTime, progress: [progress] },
				});
			};

			let contextFilePath: string | undefined;
			if (passContext) {
				const compactContext = session.subagentContext?.getCompactContext?.();
				if (compactContext) {
					contextFilePath = path.join(effectiveArtifactsDir, "context.md");
					await Bun.write(contextFilePath, compactContext);
				}
			}

			const result = await runAgent({
				cwd: session.cwd,
				agent,
				task,
				description: buildDescription(params),
				index: 0,
				id,
				isSubagent: true,
				modelOverride,
				sessionFile,
				persistArtifacts: !!artifactsDir,
				artifactsDir: effectiveArtifactsDir,
				contextFile: contextFilePath,
				enableLsp: false,
				signal,
				onProgress: emitProgress,
				authStorage: session.subagentContext?.authStorage,
				modelRegistry: session.subagentContext?.modelRegistry,
				settings: session.settings,
				contextFiles: session.contextFiles,
				skills: session.skills,
				promptTemplates: session.promptTemplates,
				mcpManager: session.subagentContext?.mcpManager,
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
}
