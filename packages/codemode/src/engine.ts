/**
 * Code Mode engine — the main entry point.
 *
 * createCodeTool() takes the existing tool registry, generates TypeScript
 * type definitions, and returns a single "code" AgentTool that the LLM
 * uses to write orchestration code instead of making individual tool calls.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
	bridgeToolFunctions,
	type CodeModeEventHandler,
	type CodeModeToolEvent,
	type DispatchFn,
} from "./event-bridge";
import { execute } from "./executor";
import { normalizeCode } from "./normalize";
import codeToolDescription from "./prompt.md" with { type: "text" };
import { generateTypes, sanitizeToolName } from "./type-generator";

const codeSchema = Type.Object({
	code: Type.String({ description: "JavaScript async arrow function to execute using the codemode API" }),
});

/** Tools excluded from Code Mode wrapping (interactive, orchestration, or lifecycle tools) */
const EXCLUDED_TOOLS = new Set(["ask", "submit_result", "todo_write"]);

/** Max characters to include from code execution result in the tool response */
const MAX_RESULT_LENGTH = 4000;

export interface CodeToolOptions {
	/** Additional tool names to exclude from Code Mode */
	excludeTools?: string[];
	/** Execution timeout in milliseconds (default: 300_000) */
	timeoutMs?: number;
}

/** Details attached to tool_execution_update for sub-tool rendering */
export interface CodeToolDetails {
	/** Sub-tool events that occurred during execution */
	events: CodeModeToolEvent[];
	/** Captured console output from the code */
	logs: string[];
}

/** Code Mode tool with access to original wrapped tools for TUI rendering */
export interface CodeModeAgentTool extends AgentTool {
	/** Map of original tool name → AgentTool, used by TUI for sub-tool rendering */
	wrappedToolMap: ReadonlyMap<string, AgentTool>;
}

/**
 * Create a single Code Mode tool from a set of existing AgentTools.
 *
 * The returned tool wraps all eligible tools into a TypeScript API.
 * The LLM writes code against this API instead of making individual
 * tool calls, reducing round-trips and context usage.
 *
 * Tools in EXCLUDED_TOOLS (ask, task, report_finding, etc.) are passed through
 * unchanged and should be registered alongside the code tool.
 *
 * @returns An object with the code tool and any excluded tools that need
 *          to be registered separately.
 */
export function createCodeTool(
	tools: AgentTool[],
	options: CodeToolOptions = {},
): { codeTool: CodeModeAgentTool; excludedTools: AgentTool[] } {
	const { excludeTools = [], timeoutMs = 300_000 } = options;
	const excludeSet = new Set([...EXCLUDED_TOOLS, ...excludeTools]);

	// Persistent state shared across all code executions in this session
	const persistentState = new Map<string, unknown>();

	const wrappedTools: AgentTool[] = [];
	const excludedTools: AgentTool[] = [];

	for (const tool of tools) {
		if (excludeSet.has(tool.name)) {
			excludedTools.push(tool);
		} else {
			wrappedTools.push(tool);
		}
	}

	// Generate TypeScript declarations for the wrapped tools
	const { declarations, nameMap } = generateTypes(wrappedTools);

	// Build the tool description with embedded TypeScript API
	const description = codeToolDescription.replace("{{types}}", declarations);

	// Build the dispatch functions map (sanitized name → executor).
	// Each fn accepts (toolCallId, args) so the event bridge's ID
	// is forwarded to tool.execute() — no duplicate ID generation.
	const buildDispatchFns = (signal?: AbortSignal, ctx?: AgentToolContext, parentToolCallId?: string) => {
		const fullResults = new Map<string, AgentToolResult>();
		const fns: Record<string, DispatchFn> = {};

		for (const tool of wrappedTools) {
			const safeName = sanitizeToolName(tool.name);
			fns[safeName] = async (toolCallId: string, args: Record<string, unknown>) => {
				// Forward onUpdate directly to the agent event stream — no intermediate CodeModeToolEvent
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
				const result = await tool.execute(toolCallId, args, signal, onUpdate, ctx);
				fullResults.set(toolCallId, result);
				const textContent = result.content
					.filter(c => c.type === "text")
					.map(c => c.text)
					.join("\n");
				return textContent ? textContent : result.details;
			};
		}

		return { fns, fullResults };
	};

	const codeTool: CodeModeAgentTool = {
		name: "code",
		label: "Code",
		description,
		parameters: codeSchema,
		concurrency: "exclusive",
		wrappedToolMap: new Map(wrappedTools.map(t => [t.name, t])),

		async execute(
			this: AgentTool,
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback,
			ctx?: AgentToolContext,
		): Promise<AgentToolResult> {
			const code = (params as { code: string }).code;
			const events: CodeModeToolEvent[] = [];

			// Build tool lookup map for sub-tool event emission
			const toolByName = new Map<string, AgentTool>();
			for (const tool of wrappedTools) {
				toolByName.set(tool.name, tool);
			}

			const eventHandler: CodeModeEventHandler = event => {
				events.push(event);

				// Emit sub-tool events directly to the agent's event stream
				if (ctx?.emit) {
					switch (event.type) {
						case "tool_start":
							ctx.emit({
								type: "tool_execution_start",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								args: event.args ?? {},
								tool: toolByName.get(event.toolName),
								parentToolCallId: _toolCallId,
							});
							break;
						case "tool_done": {
							const fullResult = fullResults.get(event.toolCallId);
							ctx.emit({
								type: "tool_execution_end",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								result: fullResult ?? {
									content: [{ type: "text" as const, text: "(no output)" }],
								},
								parentToolCallId: _toolCallId,
							});
							fullResults.delete(event.toolCallId);
							break;
						}
						case "tool_error":
							ctx.emit({
								type: "tool_execution_end",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								result: {
									content: [{ type: "text" as const, text: event.error ?? "Unknown error" }],
									isError: true,
								},
								isError: true,
								parentToolCallId: _toolCallId,
							});
							break;
					}
				}
			};

			const { fns: rawFns, fullResults } = buildDispatchFns(signal, ctx, _toolCallId);
			const bridgedFns = bridgeToolFunctions(rawFns, nameMap, eventHandler);

			// Normalize and execute
			const normalizedCode = normalizeCode(code);
			const result = await execute(normalizedCode, bridgedFns, { timeoutMs, signal, state: persistentState });

			// Build final result — keep concise since sub-tool results
			// are already shown individually in the TUI
			const parts: string[] = [];
			if (result.error) {
				parts.push(`Error: ${result.error}`);
			}
			if (result.logs.length > 0) {
				parts.push(result.logs.join("\n"));
			}
			// Summarize completed sub-tools instead of dumping full output
			const completed = events.filter(e => e.type === "tool_done");
			const failed = events.filter(e => e.type === "tool_error");
			if (completed.length > 0 || failed.length > 0) {
				const summary = [
					...completed.map(e => `${e.toolName}: done (${Math.round(e.durationMs ?? 0)}ms)`),
					...failed.map(e => `${e.toolName}: error — ${e.error}`),
				];
				parts.push(summary.join("\n"));
			}
			if (result.result !== undefined && result.result !== null) {
				const resultStr =
					typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
				if (resultStr.length <= MAX_RESULT_LENGTH) {
					parts.push(resultStr);
				} else {
					parts.push(
						`${resultStr.slice(0, MAX_RESULT_LENGTH)}\n... (${resultStr.length - MAX_RESULT_LENGTH} chars truncated)`,
					);
				}
			}
			if (parts.length === 0) {
				parts.push("(no output)");
			}

			const details: CodeToolDetails = { events, logs: result.logs };

			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details,
			};
		},
	};

	return { codeTool, excludedTools };
}
