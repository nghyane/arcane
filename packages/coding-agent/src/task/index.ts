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
import type { Theme } from "../theme/theme";
import { EventBus } from "../utils/event-bus";
import { getBundledAgent } from "./agents";
import { runAgent } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { extractAgentOutput, ProgressTracker } from "./progress-tracker";
import { renderCall, renderResult } from "./render";
import {
	type AgentProgress,
	TASK_SUBAGENT_EVENT_CHANNEL,
	type TaskParams,
	type TaskSchema,
	type TaskToolDetails,
	taskSchema,
} from "./types";

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
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Derive a CamelCase ID from a short description for artifact naming. */
function deriveId(description: string): string {
	return (
		description
			.replace(/[^a-zA-Z0-9\s]/g, "")
			.split(/\s+/)
			.filter(Boolean)
			.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
			.join("")
			.slice(0, 32) || "Task"
	);
}

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

	readonly description = [
		"Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to: grep, find, read, bash, edit, write, explore, web_search, fetch, python, undo_edit, todo_write.",
		"When to use: Complex multi-step tasks; operations producing lots of output tokens not needed after; changes across many layers after planning; when user asks to launch an 'agent'.",
		"When NOT to use: Single logical task; reading a single file; performing text search; editing a single file; not sure what changes to make.",
		"How to use: Run multiple sub-agents concurrently if tasks are independent; include all necessary context and a detailed plan; tell sub-agent how to verify work; show user concise summary of result.",
	].join(" ");

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
				content: [{ type: "text", text: `Running task...` }],
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
			const derivedId = deriveId(params.description);
			const [uniqueId] = await outputManager.allocateBatch([derivedId]);

			// Set up EventBus — all observation flows through here
			const eventBus = new EventBus();

			const tracker = new ProgressTracker({
				index: 0,
				id: uniqueId,
				agent: agentName,
				task: params.prompt,
				description: params.description,
				startTime,
				onProgress: progress => {
					progressMap.set(0, { ...structuredClone(progress) });
					emitProgress();
				},
				onTerminateRequest: () => eventBus.emit("executor:terminate", {}),
			});
			tracker.subscribe(eventBus);

			// Capture output from agent_end
			let agentOutput = "";
			const outputListener = eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, (data: unknown) => {
				const payload = data as { event?: { type: string; messages?: unknown[] } };
				if (payload.event?.type === "agent_end") {
					agentOutput = extractAgentOutput(payload.event as Parameters<typeof extractAgentOutput>[0]);
				}
			});

			const result = await runAgent({
				cwd: this.session.cwd,
				agent: effectiveAgent,
				task: params.prompt,
				description: params.description,
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
				eventBus,
				authStorage: this.session.subagentContext?.authStorage,
				modelRegistry: this.session.subagentContext?.modelRegistry,
				settings: this.session.settings,
				mcpManager: this.session.subagentContext?.mcpManager,
				contextFiles: this.session.contextFiles?.filter(f => !f.path.endsWith("AGENTS.md")),
				skills: this.session.skills,
				promptTemplates: this.session.promptTemplates,
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
				const outputFile = path.join(effectiveArtifactsDir, `${uniqueId}.md`);
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
			const output = agentOutput.trim() || result.stderr.trim() || "(no output)";

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
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: {
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}
	}
}
