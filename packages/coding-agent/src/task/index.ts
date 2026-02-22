/**
 * Task tool — delegate parallel tasks to worker subagents.
 *
 * Uses the bundled `task` agent definition. No agent selection —
 * explore and reviewer are standalone tools now.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/pi-agent-core";
import type { Usage } from "@nghyane/pi-ai";
import { Snowflake } from "@nghyane/pi-utils";
import type { ToolSession } from "..";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { Theme } from "../modes/theme/theme";
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { formatDuration } from "../tools/render-utils";
import { getBundledAgent } from "./agents";
import { runAgent } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit } from "./parallel";
import { renderCall, renderResult } from "./render";
import { renderTemplate } from "./template";
import {
	type AgentProgress,
	type SingleResult,
	type TaskParams,
	type TaskSchema,
	type TaskToolDetails,
	taskSchema,
} from "./types";

/** Format byte count for display */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { type BatchOptions, type BatchResult, type BatchTask, runTaskBatch } from "./batch";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type { AgentDefinition, AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";
export { taskSchema } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool — delegate parallel tasks to worker subagents.
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

	readonly description = renderPromptTemplate(taskDescriptionTemplate);

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
		const { context } = params;
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const agentName = "task";

		const effectiveAgent = getBundledAgent("task");
		if (!effectiveAgent) {
			return {
				content: [{ type: "text", text: "Task agent not found." }],
				details: { results: [], totalDurationMs: 0 },
			};
		}

		const modelOverride = this.session.getActiveModelString?.() ?? this.session.getModelString?.();

		if (!params.tasks || params.tasks.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No tasks provided. Use: { context?, tasks: [{id, description, assignment}, ...] }",
					},
				],
				details: {
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const tasks = params.tasks;
		const missingTaskIndexes: number[] = [];
		const idIndexes = new Map<string, number[]>();

		for (let i = 0; i < tasks.length; i++) {
			const id = tasks[i]?.id;
			if (typeof id !== "string" || id.trim() === "") {
				missingTaskIndexes.push(i);
				continue;
			}
			const normalizedId = id.toLowerCase();
			const indexes = idIndexes.get(normalizedId);
			if (indexes) {
				indexes.push(i);
			} else {
				idIndexes.set(normalizedId, [i]);
			}
		}

		const duplicateIds: Array<{ id: string; indexes: number[] }> = [];
		for (const [normalizedId, indexes] of idIndexes.entries()) {
			if (indexes.length > 1) {
				duplicateIds.push({
					id: tasks[indexes[0]]?.id ?? normalizedId,
					indexes,
				});
			}
		}

		if (missingTaskIndexes.length > 0 || duplicateIds.length > 0) {
			const problems: string[] = [];
			if (missingTaskIndexes.length > 0) {
				problems.push(`Missing task ids at indexes: ${missingTaskIndexes.join(", ")}`);
			}
			if (duplicateIds.length > 0) {
				const details = duplicateIds.map(entry => `${entry.id} (indexes ${entry.indexes.join(", ")})`).join("; ");
				problems.push(`Duplicate task ids detected (case-insensitive): ${details}`);
			}
			return {
				content: [{ type: "text", text: `Invalid tasks: ${problems.join(". ")}` }],
				details: {
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;
		const progressMap = new Map<number, AgentProgress>();

		const emitProgress = () => {
			const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
				details: {
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress,
				},
			});
		};

		try {
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });
			const compactContext = this.session.getCompactContext?.();
			let contextFilePath: string | undefined;
			if (compactContext) {
				contextFilePath = path.join(effectiveArtifactsDir, "context.md");
				await Bun.write(contextFilePath, compactContext);
			}

			const outputManager =
				this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			const uniqueIds = await outputManager.allocateBatch(tasks.map(t => t.id));
			const tasksWithUniqueIds = tasks.map((t, i) => ({ ...t, id: uniqueIds[i] }));
			const tasksWithContext = tasksWithUniqueIds.map(t => renderTemplate(context, t));
			const contextFiles = this.session.contextFiles;
			const availableSkills = this.session.skills;
			const availableSkillList = availableSkills ?? [];
			const promptTemplates = this.session.promptTemplates;
			const skillLookup = new Map(availableSkillList.map(skill => [skill.name, skill]));
			const missingSkillsByTask: Array<{ id: string; missing: string[] }> = [];
			const tasksWithSkills = tasksWithContext.map(task => {
				if (task.skills === undefined) {
					return { ...task, resolvedSkills: availableSkills, preloadedSkills: undefined };
				}
				const requested = task.skills;
				const resolved = [] as typeof availableSkillList;
				const missing: string[] = [];
				const seen = new Set<string>();
				for (const name of requested) {
					const trimmed = name.trim();
					if (!trimmed || seen.has(trimmed)) continue;
					seen.add(trimmed);
					const skill = skillLookup.get(trimmed);
					if (skill) {
						resolved.push(skill);
					} else {
						missing.push(trimmed);
					}
				}
				if (missing.length > 0) {
					missingSkillsByTask.push({ id: task.id, missing });
				}
				return { ...task, resolvedSkills: resolved, preloadedSkills: resolved };
			});

			if (missingSkillsByTask.length > 0) {
				const available = availableSkillList.map(skill => skill.name).join(", ") || "none";
				const details = missingSkillsByTask.map(entry => `${entry.id}: ${entry.missing.join(", ")}`).join("; ");
				return {
					content: [
						{
							type: "text",
							text: `Unknown skills requested: ${details}. Available skills: ${available}`,
						},
					],
					details: {
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			for (let i = 0; i < tasksWithSkills.length; i++) {
				const t = tasksWithSkills[i];
				progressMap.set(i, {
					index: i,
					id: t.id,
					agent: agentName,
					status: "pending",
					task: t.task,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					durationMs: 0,
					toolHistory: [],
					description: t.description,
				});
			}
			emitProgress();

			const runTask = async (task: (typeof tasksWithSkills)[number], index: number) => {
				return runAgent({
					cwd: this.session.cwd,
					agent: effectiveAgent,
					task: task.task,
					description: task.description,
					index,
					id: task.id,
					taskDepth: this.session.taskDepth ?? 0,
					modelOverride,
					sessionFile,
					persistArtifacts: !!artifactsDir,
					artifactsDir: effectiveArtifactsDir,
					contextFile: contextFilePath,
					enableLsp: false,
					signal,
					eventBus: undefined,
					onProgress: progress => {
						progressMap.set(index, {
							...structuredClone(progress),
						});
						emitProgress();
					},
					authStorage: this.session.authStorage,
					modelRegistry: this.session.modelRegistry,
					settings: this.session.settings,
					mcpManager: this.session.mcpManager,
					contextFiles,
					skills: task.resolvedSkills,
					preloadedSkills: task.preloadedSkills,
					promptTemplates,
				});
			};

			const { results: partialResults, aborted } = await mapWithConcurrencyLimit(
				tasksWithSkills,
				maxConcurrency,
				runTask,
				signal,
			);

			const results: SingleResult[] = partialResults.map((result, index) => {
				if (result !== undefined) {
					return result;
				}
				const task = tasksWithSkills[index];
				return {
					index,
					id: task.id,
					agent: agentName,
					task: task.task,
					description: task.description,
					exitCode: 1,
					output: "",
					stderr: "Skipped (cancelled before start)",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					error: "Skipped",
					aborted: true,
				};
			});

			const aggregatedUsage = createUsageTotals();
			let hasAggregatedUsage = false;
			for (const result of results) {
				if (result.usage) {
					addUsageTotals(aggregatedUsage, result.usage);
					hasAggregatedUsage = true;
				}
			}

			const successCount = results.filter(r => r.exitCode === 0).length;
			const cancelledCount = results.filter(r => r.aborted).length;
			const totalDuration = Date.now() - startTime;

			const summaries = results.map(r => {
				const status = r.aborted ? "cancelled" : r.exitCode === 0 ? "completed" : `failed (exit ${r.exitCode})`;
				const output = r.output.trim() || r.stderr.trim() || "(no output)";
				const outputCharCount = r.outputMeta?.charCount ?? output.length;
				const fullOutputThreshold = 5000;
				let preview = output;
				let truncated = false;
				if (outputCharCount > fullOutputThreshold) {
					const slice = output.slice(0, fullOutputThreshold);
					const lastNewline = slice.lastIndexOf("\n");
					preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
					truncated = true;
				}
				return {
					agent: r.agent,
					status,
					id: r.id,
					preview,
					truncated,
					meta: r.outputMeta
						? {
								lineCount: r.outputMeta.lineCount,
								charSize: formatBytes(r.outputMeta.charCount),
							}
						: undefined,
				};
			});

			const summary = renderPromptTemplate(taskSummaryTemplate, {
				successCount,
				totalCount: results.length,
				cancelledCount,
				hasCancelledNote: aborted && cancelledCount > 0,
				duration: formatDuration(totalDuration),
				summaries,
			});

			if (tempArtifactsDir) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			return {
				content: [{ type: "text", text: summary }],
				details: {
					results,
					totalDurationMs: totalDuration,
					usage: hasAggregatedUsage ? aggregatedUsage : undefined,
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
