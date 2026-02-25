import type { ThinkingLevel } from "@nghyane/arcane-agent";
import type { Usage } from "@nghyane/arcane-ai";
import { $env } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

/** Discriminant for agent capability profile */
export type AgentKind = "local" | "remote" | "hybrid" | "reasoning";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (!value) return defaultValue;
	const number = Number.parseInt(value, 10);
	return Number.isNaN(number) || number <= 0 ? defaultValue : number;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.ARCANE_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.ARCANE_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** Single task item for execution */
export interface TaskItem {
	id: string;
	description: string;
	assignment: string;
	skills?: string[];
}

/** Task schema — single task with optional context */
export const taskSchema = Type.Object({
	id: Type.String({
		description: "CamelCase identifier, max 32 chars",
		maxLength: 32,
	}),
	description: Type.String({
		description: "Short one-liner for UI display only \u2014 not seen by the subagent",
	}),
	assignment: Type.String({
		description:
			"Complete instructions the subagent executes. Structure: Target (files, symbols), Change (step-by-step), Edge Cases, Acceptance Criteria. Must be self-contained — subagent has no conversation history.",
	}),
	context: Type.Optional(
		Type.String({
			description:
				"Shared background prepended to assignment. Use for session-specific info subagents lack: API contracts, type definitions, reference files. Do NOT repeat AGENTS.md rules — subagents already have them.",
		}),
	),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Skill names to preload into the subagent.",
		}),
	),
	complexity: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("high")], {
			description:
				"Task complexity. 'low' for mechanical/rote changes (rename, add import, update config). 'high' for changes requiring reasoning (refactors, bug fixes, new features). Default: high.",
			default: "high",
		}),
	),
});

export type TaskSchema = typeof taskSchema;
export type TaskParams = Static<TaskSchema>;

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	kind: AgentKind;
	name: string;
	description: string;
	systemPrompt: string;
	tools: string[];
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
