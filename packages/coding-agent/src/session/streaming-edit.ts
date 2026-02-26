import * as fs from "node:fs";

import type { Agent, AgentEvent } from "@nghyane/arcane-agent";
import type { AssistantMessage, ToolCall } from "@nghyane/arcane-ai";
import { isEnoent, logger } from "@nghyane/arcane-utils";
import type { Settings } from "../config/settings";
import { normalizeDiff, normalizeToLF, ParseError, previewPatch, stripBom } from "../patch";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { resolveToCwd } from "../tools/path-utils";
import type { SessionManager } from "./session-manager";

/**
 * Mutable state for streaming edit abort detection.
 */
export interface StreamingEditState {
	abortTriggered: boolean;
	checkedLineCounts: Map<string, number>;
	fileCache: Map<string, string>;
}

export function createStreamingEditState(): StreamingEditState {
	return {
		abortTriggered: false,
		checkedLineCounts: new Map(),
		fileCache: new Map(),
	};
}

export function resetStreamingEditState(state: StreamingEditState): void {
	state.abortTriggered = false;
	state.checkedLineCounts.clear();
	state.fileCache.clear();
}

export async function preCacheStreamingEditFile(
	event: AgentEvent,
	state: StreamingEditState,
	settings: Settings,
	cwd: string,
): Promise<void> {
	if (!settings.get("edit.streamingAbort")) return;
	if (event.type !== "message_update") return;
	const assistantEvent = event.assistantMessageEvent;
	if (assistantEvent.type !== "toolcall_start") return;
	if (event.message.role !== "assistant") return;

	const contentIndex = assistantEvent.contentIndex;
	const messageContent = event.message.content;
	if (!Array.isArray(messageContent) || contentIndex >= messageContent.length) return;
	const toolCall = messageContent[contentIndex] as ToolCall;
	if (toolCall.name !== "edit") return;

	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	if ("old_text" in args || "new_text" in args) return;

	const path = typeof args.path === "string" ? args.path : undefined;
	if (!path) return;

	const resolvedPath = resolveToCwd(path, cwd);
	ensureFileCache(state, resolvedPath);
}

export function ensureFileCache(state: StreamingEditState, resolvedPath: string): void {
	if (state.fileCache.has(resolvedPath)) return;

	try {
		const rawText = fs.readFileSync(resolvedPath, "utf-8");
		const { text } = stripBom(rawText);
		state.fileCache.set(resolvedPath, normalizeToLF(text));
	} catch {
		// Don't cache on read errors (including ENOENT) - let the edit tool handle them
	}
}

export function invalidateFileCacheForPath(state: StreamingEditState, path: string, cwd: string): void {
	const resolvedPath = resolveToCwd(path, cwd);
	state.fileCache.delete(resolvedPath);
}

export function maybeAbortStreamingEdit(
	event: AgentEvent,
	state: StreamingEditState,
	settings: Settings,
	agent: Agent,
	cwd: string,
	obfuscator: SecretObfuscator | undefined,
): void {
	if (!settings.get("edit.streamingAbort")) return;
	if (state.abortTriggered) return;
	if (event.type !== "message_update") return;
	const assistantEvent = event.assistantMessageEvent;
	if (assistantEvent.type !== "toolcall_end" && assistantEvent.type !== "toolcall_delta") return;
	if (event.message.role !== "assistant") return;

	const contentIndex = assistantEvent.contentIndex;
	const messageContent = event.message.content;
	if (!Array.isArray(messageContent) || contentIndex >= messageContent.length) return;
	const toolCall = messageContent[contentIndex] as ToolCall;
	if (toolCall.name !== "edit" || !toolCall.id) return;

	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	if ("old_text" in args || "new_text" in args) return;

	const path = typeof args.path === "string" ? args.path : undefined;
	const diff = typeof args.diff === "string" ? args.diff : undefined;
	const op = typeof args.op === "string" ? args.op : undefined;
	if (!path || !diff) return;
	if (op && op !== "update") return;

	if (!diff.includes("\n")) return;
	const lastNewlineIndex = diff.lastIndexOf("\n");
	if (lastNewlineIndex < 0) return;
	const diffForCheck = diff.endsWith("\n") ? diff : diff.slice(0, lastNewlineIndex + 1);
	if (diffForCheck.trim().length === 0) return;

	let normalizedDiffResult = normalizeDiff(diffForCheck.replace(/\r/g, ""));
	if (!normalizedDiffResult) return;
	if (obfuscator) normalizedDiffResult = obfuscator.deobfuscate(normalizedDiffResult);
	if (!normalizedDiffResult) return;
	const lines = normalizedDiffResult.split("\n");
	const hasChangeLine = lines.some(line => line.startsWith("+") || line.startsWith("-"));
	if (!hasChangeLine) return;

	const lineCount = lines.length;
	const lastChecked = state.checkedLineCounts.get(toolCall.id);
	if (lastChecked !== undefined && lineCount <= lastChecked) return;
	state.checkedLineCounts.set(toolCall.id, lineCount);

	const rename = typeof args.rename === "string" ? args.rename : undefined;

	const removedLines = lines
		.filter(line => line.startsWith("-") && !line.startsWith("--- "))
		.map(line => line.slice(1));
	if (removedLines.length > 0) {
		const resolvedPath = resolveToCwd(path, cwd);
		let cachedContent = state.fileCache.get(resolvedPath);
		if (cachedContent === undefined) {
			ensureFileCache(state, resolvedPath);
			cachedContent = state.fileCache.get(resolvedPath);
		}
		if (cachedContent !== undefined) {
			const missing = removedLines.find(line => !cachedContent.includes(normalizeToLF(line)));
			if (missing) {
				state.abortTriggered = true;
				logger.warn("Streaming edit aborted due to patch preview failure", {
					toolCallId: toolCall.id,
					path,
					error: `Failed to find expected lines in ${path}:\n${missing}`,
				});
				agent.abort();
			}
			return;
		}
		if (assistantEvent.type === "toolcall_delta") return;
		void checkRemovedLinesAsync(state, agent, toolCall.id, path, resolvedPath, removedLines);
		return;
	}

	if (assistantEvent.type === "toolcall_delta") return;
	void checkPreviewPatchAsync(state, agent, settings, cwd, toolCall.id, path, rename, normalizedDiffResult);
}

async function checkRemovedLinesAsync(
	state: StreamingEditState,
	agent: Agent,
	toolCallId: string,
	path: string,
	resolvedPath: string,
	removedLines: string[],
): Promise<void> {
	if (state.abortTriggered) return;
	try {
		const { text } = stripBom(await Bun.file(resolvedPath).text());
		const normalizedContent = normalizeToLF(text);
		const missing = removedLines.find(line => !normalizedContent.includes(normalizeToLF(line)));
		if (missing) {
			state.abortTriggered = true;
			logger.warn("Streaming edit aborted due to patch preview failure", {
				toolCallId,
				path,
				error: `Failed to find expected lines in ${path}:\n${missing}`,
			});
			agent.abort();
		}
	} catch (err) {
		if (!isEnoent(err)) {
			// Log unexpected errors but don't abort
		}
	}
}

async function checkPreviewPatchAsync(
	state: StreamingEditState,
	agent: Agent,
	settings: Settings,
	cwd: string,
	toolCallId: string,
	path: string,
	rename: string | undefined,
	normalizedDiff: string,
): Promise<void> {
	if (state.abortTriggered) return;
	try {
		await previewPatch(
			{ path, op: "update", rename, diff: normalizedDiff },
			{
				cwd,
				allowFuzzy: settings.get("edit.fuzzyMatch"),
				fuzzyThreshold: settings.get("edit.fuzzyThreshold"),
			},
		);
	} catch (error) {
		if (error instanceof ParseError) return;
		state.abortTriggered = true;
		logger.warn("Streaming edit aborted due to patch preview failure", {
			toolCallId,
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		agent.abort();
	}
}

/**
 * Rewrite tool call arguments in agent state and persisted session history.
 */
export async function rewriteToolCallArgs(
	agent: Agent,
	sessionManager: SessionManager,
	toolCallId: string,
	args: Record<string, unknown>,
): Promise<void> {
	let updated = false;
	const messages = agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const assistantMsg = msg as AssistantMessage;
		if (!Array.isArray(assistantMsg.content)) continue;
		for (const block of assistantMsg.content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || (block as { type?: string }).type !== "toolCall") continue;
			const toolCall = block as { id?: string; arguments?: Record<string, unknown> };
			if (toolCall.id === toolCallId) {
				toolCall.arguments = args;
				updated = true;
				break;
			}
		}
		if (updated) break;
	}

	if (updated) {
		await sessionManager.rewriteAssistantToolCallArgs(toolCallId, args);
	}
}
