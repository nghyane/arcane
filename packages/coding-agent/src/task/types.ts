import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (!value) return defaultValue;
	const number = Number.parseInt(value, 10);
	return Number.isNaN(number) || number <= 0 ? defaultValue : number;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** Single task item for parallel execution */
export const taskItemSchema = Type.Object({
	id: Type.String({
		description: "CamelCase identifier, max 32 chars",
		maxLength: 32,
	}),
	description: Type.String({
		description: "Short one-liner for UI display only — not seen by the subagent",
	}),
	assignment: Type.String({
		description:
			"Complete per-task instructions the subagent executes. Must follow the Target/Change/Edge Cases/Acceptance structure. Only include per-task deltas — shared background belongs in `context`.",
	}),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Skill names to preload into the subagent. Use only where it changes correctness.",
		}),
	),
});
export type TaskItem = Static<typeof taskItemSchema>;

export const taskSchema = Type.Object({
	context: Type.String({
		description:
			"Shared background prepended to every task's assignment. Put goal, non-goals, constraints, conventions, reference paths, API contracts, and global acceptance commands here once \u2014 instead of duplicating across assignments.",
	}),
	tasks: Type.Array(taskItemSchema, {
		description:
			"Tasks to execute in parallel. Each must be small-scoped (3-5 files max) and self-contained given context + assignment.",
	}),
});

export type TaskSchema = typeof taskSchema;

export type TaskParams = Static<TaskSchema>;

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string[];
	thinkingLevel?: ThinkingLevel;
	source: AgentSource;
	filePath?: string;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource?: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	/** Full history of tool calls for nested display */
	toolHistory: Array<{ tool: string; args: string; status: "success" | "error" | "running" }>;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource?: AgentSource;
	task: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	tokens: number;
	error?: string;
	aborted?: boolean;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number };
	/** Full history of tool calls for nested display */
	toolHistory?: Array<{ tool: string; args: string; status: "success" | "error" }>;
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	results: SingleResult[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	progress?: AgentProgress[];
}
