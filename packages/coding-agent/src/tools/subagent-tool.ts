/**
 * Subagent tool system.
 *
 * All standalone subagent tools (explore, oracle, librarian, code_review)
 * share identical execution logic. Each tool is a config object;
 * SubagentTool is the single class that runs them.
 *
 * Rendering is assigned to the tool instance via createUnifiedSubagentRenderer.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Snowflake } from "@nghyane/arcane-utils";
import type { TObject, TProperties } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { isDefaultModelAlias } from "../config/model-resolver";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { getBundledAgent } from "../task/agents";
import { runAgent } from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import { extractAgentOutput, ProgressTracker } from "../task/progress-tracker";
import { createUnifiedSubagentRenderer } from "../task/render";
import type { TaskToolDetails } from "../task/types";
import { TASK_SUBAGENT_EVENT_CHANNEL } from "../task/types";
import type { Theme } from "../theme/theme";
import { EventBus } from "../utils/event-bus";

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
	readonly mergeCallAndResult = true;
	declare renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	declare renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: unknown,
	) => Component;

	#config: SubagentConfig<T>;
	#session: ToolSession;

	constructor(session: ToolSession, config: SubagentConfig<T>) {
		this.#config = config;
		this.#session = session;
		this.name = config.name;
		this.label = config.label;
		this.parameters = config.schema;
		this.description = config.toolDescription ?? "";
		const renderer = createUnifiedSubagentRenderer({
			label: config.label,
			getDescription: args => config.buildDescription(args),
			getContextLine: config.buildContextLine ? args => config.buildContextLine!(args) : undefined,
		});
		this.renderCall = renderer.renderCall;
		this.renderResult = renderer.renderResult;
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

			// Set up EventBus — all observation flows through here
			const eventBus = new EventBus();

			// Progress tracker subscribes to events
			const tracker = new ProgressTracker({
				index: 0,
				id,
				agent: agentName,
				task,
				description: buildDescription(params),
				startTime,
				onProgress: progress => {
					onUpdate?.({
						content: [{ type: "text", text: progressText }],
						details: { results: [], totalDurationMs: Date.now() - startTime, progress: [progress] },
					});
				},
				onTerminateRequest: () => eventBus.emit("executor:terminate", {}),
			});
			tracker.subscribe(eventBus);

			// Capture output from agent_end event
			let agentOutput = "";
			const outputListener = eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, (data: unknown) => {
				const payload = data as { event?: { type: string; messages?: unknown[] } };
				if (payload.event?.type === "agent_end") {
					agentOutput = extractAgentOutput(payload.event as Parameters<typeof extractAgentOutput>[0]);
				}
			});

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
				eventBus,
				authStorage: session.subagentContext?.authStorage,
				modelRegistry: session.subagentContext?.modelRegistry,
				settings: session.settings,
				contextFiles: session.contextFiles,
				skills: session.skills,
				promptTemplates: session.promptTemplates,
				mcpManager: session.subagentContext?.mcpManager,
			});

			// Finalize tracker
			const wasAborted = result.aborted ?? false;
			tracker.finalize(wasAborted ? "aborted" : result.exitCode === 0 ? "completed" : "failed");
			tracker.dispose();
			outputListener();

			// Enrich result with tracker data
			result.tokens = tracker.progress.tokens;
			result.lastIntent = tracker.progress.lastIntent;
			result.usage = tracker.usage;
			result.toolHistory = tracker.progress.toolHistory.map(t => ({
				tool: t.tool,
				args: t.args,
				status: t.status === "running" ? ("error" as const) : t.status,
			}));

			// Write output artifact for agent:// URL integration
			if (artifactsDir && agentOutput) {
				const outputFile = path.join(effectiveArtifactsDir, `${id}.md`);
				try {
					await Bun.write(outputFile, agentOutput);
				} catch {
					// Non-fatal
				}
			}

			if (tempArtifactsDir) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			const totalDuration = Date.now() - startTime;
			const output = agentOutput.trim() || result.stderr.trim() || `${label} produced no output`;

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
