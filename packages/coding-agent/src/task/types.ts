import type { ThinkingLevel } from "@nghyane/arcane-agent";
import type { Usage } from "@nghyane/arcane-ai";
import { type Static, Type } from "@sinclair/typebox";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

/** Discriminant for agent capability profile */
export type AgentKind = "local" | "remote" | "hybrid" | "reasoning";

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** Task schema — simplified prompt + description */
export const taskSchema = Type.Object({
	prompt: Type.String({
		description:
			"The task for the agent to perform. Be specific about what needs to be done and include any relevant context.",
	}),
	description: Type.String({
		description: "A very short description of the task that can be displayed to the user.",
	}),
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
	stderr: string;
	durationMs: number;
	tokens: number;
	error?: string;
	aborted?: boolean;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
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
