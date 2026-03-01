/**
 * Code tool — wraps all tools into a single LLM-callable tool.
 * The LLM writes async arrow functions against a typed `codemode.*` API.
 * Connects codemode's pure executor with the agent's event system.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import {
	AbortExecution,
	type ExecutionError,
	execute,
	generateTypes,
	getCurrentStepId,
	normalizeCode,
	sanitizeToolName,
} from "@nghyane/arcane-codemode";
import { Type } from "@sinclair/typebox";
import codeToolDescription from "./code-tool-prompt.md" with { type: "text" };

const MAX_RESULT_LENGTH = 4000;

export interface CodeToolOptions {
	timeoutMs?: number;
}

export interface CodeAgentTool extends AgentTool {
	wrappedToolMap: ReadonlyMap<string, AgentTool>;
}

interface SubToolRecord {
	toolCallId: string;
	toolName: string;
	status: "running" | "done" | "error";
	durationMs?: number;
	resultText?: string;
	error?: string;
}

export function createCodeTool(tools: AgentTool[], options: CodeToolOptions = {}): { codeTool: CodeAgentTool } {
	const { timeoutMs = 300_000 } = options;
	const persistentState = new Map<string, unknown>();
	const VERBOSE_TOOLS = new Set(["edit", "lsp", "task"]);
	const { declarations } = generateTypes(
		tools.map(t => ({ name: t.name, parameters: t.parameters, compact: !VERBOSE_TOOLS.has(t.name) })),
	);
	const description = codeToolDescription.replace("{{types}}", declarations);
	const toolByName = new Map<string, AgentTool>(tools.map(t => [t.name, t]));

	const codeTool: CodeAgentTool = {
		name: "code",
		label: "Code",
		description,
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript async arrow function to execute using the tool API" }),
		}),
		concurrency: "shared",
		wrappedToolMap: toolByName,

		async execute(
			this: AgentTool,
			parentToolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback,
			ctx?: AgentToolContext,
		): Promise<AgentToolResult> {
			const code = (params as { code: string }).code;
			const records: SubToolRecord[] = [];

			const fns: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
			for (const tool of tools) {
				fns[sanitizeToolName(tool.name)] = args =>
					dispatchToolCall(tool, args, records, parentToolCallId, signal, ctx);
			}

			// abort(message) — clean intentional exit
			const abort = (message: string): never => {
				throw new AbortExecution(message);
			};

			const stepTimers = new Map<string, number>();
			const result = await execute(normalizeCode(code), fns, {
				timeoutMs,
				signal,
				state: persistentState,
				injectedGlobals: { abort },
				onStep: event => {
					if (event.type === "start") {
						stepTimers.set(event.stepId, performance.now());
						ctx?.emit?.({
							type: "step_start",
							toolCallId: parentToolCallId,
							stepId: event.stepId,
							intent: event.intent,
							parentStepId: event.parentStepId,
						});
					} else {
						const startTime = stepTimers.get(event.stepId);
						const durationMs = startTime !== undefined ? performance.now() - startTime : 0;
						stepTimers.delete(event.stepId);
						ctx?.emit?.({
							type: "step_end",
							toolCallId: parentToolCallId,
							stepId: event.stepId,
							durationMs,
						});
					}
				},
				onProgress: (stepId, message) => {
					ctx?.emit?.({ type: "step_progress", toolCallId: parentToolCallId, stepId, message });
				},
			});

			if (result.abortMessage) {
				ctx?.emit?.({ type: "execution_abort", toolCallId: parentToolCallId, message: result.abortMessage });
				return { content: [{ type: "text", text: `Aborted: ${result.abortMessage}` }] };
			}

			const text = buildResponse(result.result, result.error, result.logs, records);
			return { content: [{ type: "text", text }] };
		},
	};

	return { codeTool };
}

async function dispatchToolCall(
	tool: AgentTool,
	args: Record<string, unknown>,
	records: SubToolRecord[],
	parentToolCallId: string,
	signal?: AbortSignal,
	ctx?: AgentToolContext,
): Promise<unknown> {
	const toolCallId = `code_${tool.name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const record: SubToolRecord = { toolCallId, toolName: tool.name, status: "running" };
	records.push(record);
	const start = performance.now();

	ctx?.emit?.({
		type: "tool_execution_start",
		toolCallId,
		toolName: tool.name,
		args,
		tool,
		parentToolCallId,
		stepId: getCurrentStepId(),
	});

	const onUpdate: AgentToolUpdateCallback | undefined = ctx?.emit
		? partialResult => {
				ctx.emit!({
					type: "tool_execution_update",
					toolCallId,
					toolName: tool.name,
					args,
					partialResult: partialResult as AgentToolResult,
					parentToolCallId,
				});
			}
		: undefined;

	try {
		const result = await tool.execute(toolCallId, args, signal, onUpdate, ctx);
		record.status = "done";
		record.durationMs = performance.now() - start;
		record.resultText = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		ctx?.emit?.({
			type: "tool_execution_end",
			toolCallId,
			toolName: tool.name,
			result,
			parentToolCallId,
		});
		return record.resultText || result.details;
	} catch (err) {
		record.status = "error";
		record.durationMs = performance.now() - start;
		record.error = err instanceof Error ? err.message : String(err);

		ctx?.emit?.({
			type: "tool_execution_end",
			toolCallId,
			toolName: tool.name,
			result: { content: [{ type: "text" as const, text: record.error }] },
			isError: true,
			parentToolCallId,
		});
		throw err;
	}
}

/**
 * Build outcome-aware LLM response.
 * Success: concise summary + return value.
 * Error: error + truncated results from completed tools.
 */
function buildResponse(
	result: unknown,
	error: ExecutionError | undefined,
	logs: string[],
	records: SubToolRecord[],
): string {
	const parts: string[] = [];

	if (error) {
		const ep = [`Error [${error.type}]: ${error.message}`];
		if (error.toolName) ep.push(`Tool: ${error.toolName}`);
		if (error.snippet) ep.push(error.snippet);
		parts.push(ep.join("\n"));
	}

	if (logs.length > 0) parts.push(logs.join("\n"));

	const done = records.filter(r => r.status === "done");
	const failed = records.filter(r => r.status === "error");
	const running = records.filter(r => r.status === "running");

	if (error) {
		// Error recovery — show what completed so LLM doesn't re-call
		if (done.length > 0) {
			const available = Math.max(0, MAX_RESULT_LENGTH - partsLength(parts) - 50);
			const perTool = Math.floor(available / done.length);
			const lines = ["Completed before error:"];
			for (const r of done) {
				const prefix = `  ${r.toolName}: `;
				if (!r.resultText || perTool < 50) {
					lines.push(`${prefix}done (${Math.round(r.durationMs ?? 0)}ms)`);
				} else {
					const max = perTool - prefix.length;
					lines.push(
						r.resultText.length <= max ? `${prefix}${r.resultText}` : `${prefix}${r.resultText.slice(0, max)}...`,
					);
				}
			}
			parts.push(lines.join("\n"));
		}
		if (failed.length > 0) {
			parts.push(failed.map(r => `${r.toolName}: error — ${r.error}`).join("\n"));
		}
		if (running.length > 0) {
			parts.push(`In-flight when error occurred: ${running.map(r => r.toolName).join(", ")}`);
		}
	} else {
		// Success — concise summary
		if (done.length > 0 || failed.length > 0) {
			parts.push(
				[
					...done.map(r => `${r.toolName}: done (${Math.round(r.durationMs ?? 0)}ms)`),
					...failed.map(r => `${r.toolName}: error — ${r.error}`),
				].join("\n"),
			);
		}
		if (result !== undefined && result !== null) {
			const str = typeof result === "string" ? result : JSON.stringify(result, null, 2);
			const remaining = MAX_RESULT_LENGTH - partsLength(parts);
			if (remaining > 0) {
				parts.push(
					str.length <= remaining
						? str
						: `${str.slice(0, remaining)}\n... (${str.length - remaining} chars truncated)`,
				);
			}
		}
	}

	return parts.filter(Boolean).join("\n\n") || "(no output)";
}

function partsLength(parts: string[]): number {
	return parts.reduce((s, p) => s + p.length + 2, 0);
}
