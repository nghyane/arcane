/**
 * Task tool — delegate a task to a worker subagent.
 *
 * Always uses the bundled `task` agent. No agent selection —
 * explore and reviewer are standalone tools now.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import { Snowflake } from "@nghyane/arcane-utils";
import type { ToolSession } from "..";
import type { Theme } from "../modes/theme/theme";
import { getBundledAgent } from "./agents";
import { runAgent } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { renderCall, renderResult } from "./render";
import { renderTemplate } from "./template";
import { type AgentProgress, type TaskParams, type TaskSchema, type TaskToolDetails, taskSchema } from "./types";

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	TaskParams,
	TaskToolDetails,
} from "./types";
export { taskSchema } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool — delegate a task to a worker subagent.
 *
 * Always uses the bundled `task` agent. No agent selection.
 * Use `TaskTool.create(session)` to instantiate.
 */
export class TaskTool implements AgentTool<TaskSchema, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly label = "Task";
	readonly parameters: TaskSchema;
	readonly renderCall = renderCall;
	readonly renderResult = renderResult;
	readonly mergeCallAndResult = true;

	readonly description = "Delegate work to a subagent for parallel execution";

	private constructor(private readonly session: ToolSession) {
		this.parameters = taskSchema;
	}

	/** Create a TaskTool instance. */
	static async create(session: ToolSession): Promise<TaskTool> {
		return new TaskTool(session);
	}

	async execute(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const agentName = "task";

		const effectiveAgent = getBundledAgent("task");
		if (!effectiveAgent) {
			return {
				content: [{ type: "text", text: "Task agent not found." }],
				details: { results: [], totalDurationMs: 0 },
			};
		}

		const isLowComplexity = params.complexity === "low";
		const modelOverride = isLowComplexity
			? "arcane/fast"
			: (this.session.getActiveModelString?.() ?? this.session.getModelString?.());
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `arcane-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		const progressMap = new Map<number, AgentProgress>();
		const emitProgress = () => {
			const progress = Array.from(progressMap.values());
			onUpdate?.({
				content: [{ type: "text", text: `Running task ${params.id}...` }],
				details: {
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress,
				},
			});
		};

		try {
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });
			const compactContext = this.session.subagentContext?.getCompactContext?.();
			let contextFilePath: string | undefined;
			if (compactContext) {
				contextFilePath = path.join(effectiveArtifactsDir, "context.md");
				await Bun.write(contextFilePath, compactContext);
			}

			const outputManager =
				this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			const [uniqueId] = await outputManager.allocateBatch([params.id]);

			// Build task text from context + assignment
			const taskItem = {
				id: uniqueId,
				description: params.description,
				assignment: params.assignment,
				skills: params.skills,
			};
			const rendered = renderTemplate(params.context ?? "", taskItem);

			// Resolve skills
			const contextFiles = this.session.contextFiles;
			const availableSkills = this.session.skills;
			const promptTemplates = this.session.promptTemplates;
			let resolvedSkills = availableSkills;
			let preloadedSkills: typeof availableSkills | undefined;

			if (params.skills !== undefined && availableSkills) {
				const skillLookup = new Map(availableSkills.map(s => [s.name, s]));
				const resolved: typeof availableSkills = [];
				const missing: string[] = [];
				for (const name of params.skills) {
					const trimmed = name.trim();
					if (!trimmed) continue;
					const skill = skillLookup.get(trimmed);
					if (skill) resolved.push(skill);
					else missing.push(trimmed);
				}
				if (missing.length > 0) {
					const available = availableSkills.map(s => s.name).join(", ") || "none";
					return {
						content: [
							{
								type: "text",
								text: `Unknown skills: ${missing.join(", ")}. Available: ${available}`,
							},
						],
						details: { results: [], totalDurationMs: Date.now() - startTime },
					};
				}
				resolvedSkills = resolved;
				preloadedSkills = resolved;
			}

			progressMap.set(0, {
				index: 0,
				id: uniqueId,
				agent: agentName,
				status: "pending",
				task: rendered.task,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
				toolHistory: [],
			});
			emitProgress();

			const result = await runAgent({
				cwd: this.session.cwd,
				agent: effectiveAgent,
				task: rendered.task,
				description: rendered.description,
				index: 0,
				id: uniqueId,
				isSubagent: true,
				modelOverride,
				thinkingLevel: isLowComplexity ? "minimal" : undefined,
				sessionFile,
				persistArtifacts: !!artifactsDir,
				artifactsDir: effectiveArtifactsDir,
				contextFile: contextFilePath,
				enableLsp: false,
				signal,
				eventBus: undefined,
				onProgress: progress => {
					progressMap.set(0, { ...structuredClone(progress) });
					emitProgress();
				},
				authStorage: this.session.subagentContext?.authStorage,
				modelRegistry: this.session.subagentContext?.modelRegistry,
				settings: this.session.settings,
				mcpManager: this.session.subagentContext?.mcpManager,
				contextFiles,
				skills: resolvedSkills,
				preloadedSkills,
				promptTemplates,
			});

			if (tempArtifactsDir) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			const totalDuration = Date.now() - startTime;
			const output = result.output.trim() || result.stderr.trim() || "(no output)";

			// Return structured result as JSON for code tool composability
			const structured = {
				exitCode: result.exitCode,
				output,
				tokens: result.tokens,
				durationMs: result.durationMs,
			};

			return {
				content: [{ type: "text", text: JSON.stringify(structured) }],
				details: {
					results: [result],
					totalDurationMs: totalDuration,
					usage: result.usage,
				},
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: {
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}
	}
}
