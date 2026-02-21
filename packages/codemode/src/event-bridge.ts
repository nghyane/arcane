/**
 * Event bridge for Code Mode sub-tool execution.
 *
 * Intercepts every `codemode.*` call inside the sandbox and emits
 * tool_start / tool_done / tool_error events so the TUI can render
 * each sub-tool execution as if it were a normal tool call.
 */

export interface CodeModeToolEvent {
	type: "tool_start" | "tool_done" | "tool_error";
	/** Unique ID for this sub-tool call (used by TUI to track components) */
	toolCallId: string;
	/** Original tool name (e.g., "bash", "read", "write") */
	toolName: string;
	args?: Record<string, unknown>;
	result?: unknown;
	error?: string;
	durationMs?: number;
}

export type CodeModeEventHandler = (event: CodeModeToolEvent) => void;

/** Dispatch function that accepts a toolCallId for consistent tracking */
export type DispatchFn = (toolCallId: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Wrap tool functions with event emission.
 *
 * Returns a new function map where each call emits tool_start before
 * execution and tool_done/tool_error after, forwarding to the original.
 * The bridge generates the toolCallId and passes it to the dispatch fn
 * so both the event and the underlying tool.execute() use the same ID.
 */
export function bridgeToolFunctions(
	fns: Record<string, DispatchFn>,
	/** Map from sanitized name → original tool name */
	nameMap: Map<string, string>,
	onEvent: CodeModeEventHandler,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	const bridged: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};

	for (const [safeName, fn] of Object.entries(fns)) {
		bridged[safeName] = async (args: Record<string, unknown>) => {
			const originalName = nameMap.get(safeName) ?? safeName;
			const toolCallId = `codemode_${originalName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

			onEvent({ type: "tool_start", toolCallId, toolName: originalName, args });
			const start = performance.now();
			try {
				const result = await fn(toolCallId, args);
				const durationMs = performance.now() - start;
				onEvent({ type: "tool_done", toolCallId, toolName: originalName, args, result, durationMs });
				return result;
			} catch (err) {
				const durationMs = performance.now() - start;
				const error = err instanceof Error ? err.message : String(err);
				onEvent({ type: "tool_error", toolCallId, toolName: originalName, args, error, durationMs });
				throw err;
			}
		};
	}

	return bridged;
}
