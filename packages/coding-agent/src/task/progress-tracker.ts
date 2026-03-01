/**
 * Progress observer for subagent execution.
 *
 * Subscribes to raw AgentEvents via EventBus and maintains:
 * - TUI progress state (tool history, recent output, status)
 * - Usage accumulation (tokens, cost)
 *
 * Pure observer — does not control execution lifecycle.
 */
import type { AgentEvent } from "@nghyane/arcane-agent";
import type { Usage } from "@nghyane/arcane-ai";
import type { EventBus } from "../utils/event-bus";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import { type AgentProgress, TASK_SUBAGENT_EVENT_CHANNEL } from "./types";

const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;

function extractToolArgsPreview(args: Record<string, unknown>): string {
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}
	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;
	const totalTokens = firstNumberField(record, ["totalTokens", "total_tokens"]);
	if (totalTokens !== undefined && totalTokens > 0) return totalTokens;
	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheRead = firstNumberField(record, ["cacheRead", "cache_read", "cacheReadTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;
	return input + output + cacheRead + cacheWrite;
}

function getMessageField<K extends string>(message: unknown, key: K): unknown {
	if (message && typeof message === "object" && key in message) {
		return (message as Record<string, unknown>)[key];
	}
	return undefined;
}

export interface ProgressTrackerOptions {
	index: number;
	id: string;
	agent: string;
	task: string;
	description?: string;
	startTime: number;
	/** Minimum ms between progress emissions */
	coalesceMs?: number;
	onProgress?: (progress: AgentProgress) => void;
	/** Called when a tool handler signals termination (e.g. shouldTerminate). */
	onTerminateRequest?: () => void;
}

export class ProgressTracker {
	#progress: AgentProgress;
	#options: ProgressTrackerOptions;
	#recentOutputTail = "";
	#lastProgressEmitMs = 0;
	#progressTimeoutId?: NodeJS.Timeout;
	#coalesceMs: number;
	#unsubscribe?: () => void;

	// Usage accumulation
	#usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	#hasUsage = false;

	constructor(options: ProgressTrackerOptions) {
		this.#options = options;
		this.#coalesceMs = options.coalesceMs ?? 150;
		this.#progress = {
			index: options.index,
			id: options.id,
			agent: options.agent,
			status: "running",
			task: options.task,
			description: options.description,
			lastIntent: undefined,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			toolHistory: [],
		};
	}

	/** Subscribe to raw agent events on an EventBus. */
	subscribe(eventBus: EventBus): void {
		this.#unsubscribe = eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, (data: unknown) => {
			const payload = data as { event?: AgentEvent };
			if (payload.event) {
				this.#processEvent(payload.event);
			}
		});
	}

	get progress(): AgentProgress {
		return this.#progress;
	}

	/** Accumulated usage, or undefined if no usage events received. */
	get usage(): Usage | undefined {
		return this.#hasUsage ? this.#usage : undefined;
	}

	/** Set terminal status and flush. */
	finalize(status: "completed" | "failed" | "aborted"): void {
		this.#progress.status = status;
		this.#progress.currentTool = undefined;
		this.#progress.currentToolArgs = undefined;
		this.#progress.currentToolStartMs = undefined;
		this.#flushProgress();
	}

	/** Clean up timers and subscription. */
	dispose(): void {
		if (this.#progressTimeoutId) {
			clearTimeout(this.#progressTimeoutId);
			this.#progressTimeoutId = undefined;
		}
		this.#unsubscribe?.();
	}

	#processEvent(event: AgentEvent): void {
		const now = Date.now();
		let flush = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					this.#resetRecentOutput();
				}
				break;
			case "tool_execution_start":
				this.#handleToolStart(event, now);
				flush = true;
				break;
			case "tool_execution_end":
				this.#handleToolEnd(event, now);
				flush = true;
				break;
			case "message_update":
				this.#handleMessageUpdate(event);
				break;
			case "message_end":
				this.#handleMessageEnd(event);
				break;
			case "agent_end":
				flush = true;
				break;
		}

		this.#scheduleProgress(flush);
	}

	// -- Tool events --

	#handleToolStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>, now: number): void {
		const toolArgs = extractToolArgsPreview(event.args ?? {});

		this.#progress.toolCount++;
		this.#progress.currentTool = event.toolName;
		this.#progress.currentToolArgs = toolArgs;
		this.#progress.currentToolStartMs = now;
		const intent = event.intent?.trim();
		if (intent) {
			this.#progress.lastIntent = intent;
		}

		if (this.#progress.toolHistory.length < 50) {
			this.#progress.toolHistory.push({
				tool: event.toolName,
				args: toolArgs,
				status: "running",
			});
		}
	}

	#handleToolEnd(event: Extract<AgentEvent, { type: "tool_execution_end" }>, now: number): void {
		const isError = !!(event as { isError?: boolean }).isError;

		for (let i = this.#progress.toolHistory.length - 1; i >= 0; i--) {
			if (this.#progress.toolHistory[i].status === "running") {
				this.#progress.toolHistory[i].status = isError ? "error" : "success";
				break;
			}
		}

		if (this.#progress.currentTool) {
			this.#progress.recentTools.unshift({
				tool: this.#progress.currentTool,
				args: this.#progress.currentToolArgs || "",
				endMs: now,
			});
			if (this.#progress.recentTools.length > 5) {
				this.#progress.recentTools.pop();
			}
		}
		this.#progress.currentTool = undefined;
		this.#progress.currentToolArgs = undefined;
		this.#progress.currentToolStartMs = undefined;

		const handler = subprocessToolRegistry.getHandler(event.toolName);
		if (handler) {
			const eventArgs = (event as { args?: Record<string, unknown> }).args ?? {};
			if (
				handler.shouldTerminate?.({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					args: eventArgs,
					result: event.result,
					isError: event.isError,
				})
			) {
				this.#options.onTerminateRequest?.();
			}
		}
	}
	// -- Message events --

	#handleMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
		if (event.message?.role !== "assistant") return;
		const assistantEvent = (
			event as AgentEvent & {
				assistantMessageEvent?: { type?: string; delta?: string };
			}
		).assistantMessageEvent;
		if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
			this.#appendRecentOutputTail(assistantEvent.delta);
			return;
		}
		if (assistantEvent && assistantEvent.type !== "text_delta") {
			return;
		}
		const content =
			getMessageField(event.message, "content") ?? (event as AgentEvent & { content?: unknown }).content;
		if (content && Array.isArray(content)) {
			this.#replaceRecentOutputFromContent(content);
		}
	}

	#handleMessageEnd(event: Extract<AgentEvent, { type: "message_end" }>): void {
		const role = event.message?.role;
		const messageUsage = getMessageField(event.message, "usage") ?? (event as AgentEvent & { usage?: unknown }).usage;
		if (!messageUsage || typeof messageUsage !== "object") return;

		this.#progress.tokens += getUsageTokens(messageUsage);

		if (role === "assistant") {
			this.#hasUsage = true;
			const u = messageUsage as Record<string, unknown>;
			this.#usage.input += getNumberField(u, "input") ?? 0;
			this.#usage.output += getNumberField(u, "output") ?? 0;
			this.#usage.cacheRead += getNumberField(u, "cacheRead") ?? 0;
			this.#usage.cacheWrite += getNumberField(u, "cacheWrite") ?? 0;
			this.#usage.totalTokens += getNumberField(u, "totalTokens") ?? 0;
			const costRecord = (u as { cost?: Record<string, unknown> }).cost;
			if (costRecord) {
				this.#usage.cost.input += getNumberField(costRecord, "input") ?? 0;
				this.#usage.cost.output += getNumberField(costRecord, "output") ?? 0;
				this.#usage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
				this.#usage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
				this.#usage.cost.total += getNumberField(costRecord, "total") ?? 0;
			}
		}
	}

	// -- Recent output tracking --

	#resetRecentOutput(): void {
		this.#recentOutputTail = "";
		this.#progress.recentOutput = [];
	}

	#appendRecentOutputTail(text: string): void {
		if (!text) return;
		this.#recentOutputTail += text;
		if (this.#recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			this.#recentOutputTail = this.#recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		this.#updateRecentOutputLines();
	}

	#replaceRecentOutputFromContent(content: unknown[]): void {
		this.#recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			this.#recentOutputTail += record.text;
			if (this.#recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				this.#recentOutputTail = this.#recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		this.#updateRecentOutputLines();
	}

	#updateRecentOutputLines(): void {
		const lines = this.#recentOutputTail.split("\n").filter(line => line.trim());
		this.#progress.recentOutput = lines.slice(-8).reverse();
	}

	// -- Progress coalescing --

	#emitProgressNow(): void {
		this.#progress.durationMs = Date.now() - this.#options.startTime;
		this.#options.onProgress?.({ ...this.#progress });
		this.#lastProgressEmitMs = Date.now();
	}

	#flushProgress(): void {
		if (this.#progressTimeoutId) {
			clearTimeout(this.#progressTimeoutId);
			this.#progressTimeoutId = undefined;
		}
		this.#emitProgressNow();
	}

	#scheduleProgress(flush = false): void {
		if (flush) {
			this.#flushProgress();
			return;
		}
		const now = Date.now();
		const elapsed = now - this.#lastProgressEmitMs;
		if (this.#lastProgressEmitMs === 0 || elapsed >= this.#coalesceMs) {
			this.#flushProgress();
			return;
		}
		if (this.#progressTimeoutId) return;
		this.#progressTimeoutId = setTimeout(() => {
			this.#progressTimeoutId = undefined;
			this.#emitProgressNow();
		}, this.#coalesceMs - elapsed);
	}
}

/**
 * Extract the last assistant message text from an agent_end event.
 * Callers use this to get subagent output from the EventBus.
 */
export function extractAgentOutput(event: Extract<AgentEvent, { type: "agent_end" }>): string {
	const messages = event.messages;
	if (!messages || !Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if ((msg as { role?: string })?.role !== "assistant") continue;
		const content = (msg as { content?: unknown[] })?.content;
		if (!content || !Array.isArray(content)) continue;
		const chunks: string[] = [];
		for (const block of content) {
			if ((block as { type?: string })?.type === "text" && (block as { text?: string })?.text) {
				chunks.push((block as { text: string }).text);
			}
		}
		if (chunks.length > 0) return chunks.join("");
		break;
	}
	return "";
}
