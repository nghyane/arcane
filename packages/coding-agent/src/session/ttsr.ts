import * as path from "node:path";

import type { Agent, AgentMessage } from "@nghyane/arcane-agent";
import type { AssistantMessage, ToolCall } from "@nghyane/arcane-ai";
import type { Rule } from "../capability/rule";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import type { SessionManager } from "./session-manager";

/**
 * Mutable state for TTSR (time-traveling stream rules).
 */
export interface TtsrState {
	pendingInjections: Rule[];
	abortPending: boolean;
	retryToken: number;
}

export function createTtsrState(): TtsrState {
	return {
		pendingInjections: [],
		abortPending: false,
		retryToken: 0,
	};
}

/** Get TTSR injection payload and clear pending injections. */
export function getTtsrInjectionContent(state: TtsrState): { content: string; rules: Rule[] } | undefined {
	if (state.pendingInjections.length === 0) return undefined;
	const rules = state.pendingInjections;
	const content = rules
		.map(r => renderPromptTemplate(ttsrInterruptTemplate, { name: r.name, path: r.path, content: r.content }))
		.join("\n\n");
	state.pendingInjections = [];
	return { content, rules };
}

export function addPendingTtsrInjections(state: TtsrState, rules: Rule[]): void {
	const seen = new Set(state.pendingInjections.map(rule => rule.name));
	for (const rule of rules) {
		if (seen.has(rule.name)) continue;
		state.pendingInjections.push(rule);
		seen.add(rule.name);
	}
}

export function extractTtsrRuleNames(details: unknown): string[] {
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return [];
	}
	const rules = (details as { rules?: unknown }).rules;
	if (!Array.isArray(rules)) {
		return [];
	}
	return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
}

export function markTtsrInjected(
	ttsrManager: TtsrManager | undefined,
	sessionManager: SessionManager,
	ruleNames: string[],
): void {
	const uniqueRuleNames = Array.from(
		new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
	);
	if (uniqueRuleNames.length === 0) {
		return;
	}
	ttsrManager?.markInjectedByNames(uniqueRuleNames);
	sessionManager.appendTtsrInjection(uniqueRuleNames);
}

export function findTtsrAssistantIndex(messages: AgentMessage[], targetTimestamp: number | undefined): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") {
			continue;
		}
		if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
			return i;
		}
	}
	return -1;
}

export function shouldInterruptForTtsrMatch(
	ttsrManager: TtsrManager | undefined,
	matchContext: TtsrMatchContext,
): boolean {
	const mode = ttsrManager?.getSettings().interruptMode ?? "always";
	if (mode === "never") {
		return false;
	}
	if (mode === "prose-only") {
		return matchContext.source === "text" || matchContext.source === "thinking";
	}
	if (mode === "tool-only") {
		return matchContext.source === "tool";
	}
	return true;
}

export function queueDeferredTtsrInjectionIfNeeded(
	state: TtsrState,
	agent: Agent,
	assistantMsg: AssistantMessage,
): void {
	if (state.abortPending || state.pendingInjections.length === 0) {
		return;
	}
	if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
		state.pendingInjections = [];
		return;
	}

	const injection = getTtsrInjectionContent(state);
	if (!injection) {
		return;
	}
	agent.followUp({
		role: "custom",
		customType: "ttsr-injection",
		content: injection.content,
		display: false,
		details: { rules: injection.rules.map(rule => rule.name) },
		timestamp: Date.now(),
	});
	setTimeout(() => {
		if (agent.state.isStreaming || !agent.hasQueuedMessages()) {
			return;
		}
		agent.continue().catch(() => {});
	}, 0);
}

/** Build TTSR match context for tool call argument deltas. */
export function getTtsrToolMatchContext(message: AgentMessage, contentIndex: number, cwd: string): TtsrMatchContext {
	const context: TtsrMatchContext = { source: "tool" };
	if (message.role !== "assistant") {
		return context;
	}

	const content = message.content;
	if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
		return context;
	}

	const block = content[contentIndex];
	if (!block || typeof block !== "object" || block.type !== "toolCall") {
		return context;
	}

	const toolCall = block as ToolCall;
	context.toolName = toolCall.name;
	context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
	context.filePaths = extractTtsrFilePathsFromArgs(toolCall.arguments, cwd);
	return context;
}

/** Extract path-like arguments from tool call payload for TTSR glob matching. */
export function extractTtsrFilePathsFromArgs(args: unknown, cwd: string): string[] | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return undefined;
	}

	const rawPaths: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const normalizedKey = key.toLowerCase();
		if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
			rawPaths.push(value);
			continue;
		}
		if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
			for (const candidate of value) {
				if (typeof candidate === "string") {
					rawPaths.push(candidate);
				}
			}
		}
	}

	const normalizedPaths = rawPaths.flatMap(pathValue => normalizeTtsrPathCandidates(pathValue, cwd));
	if (normalizedPaths.length === 0) {
		return undefined;
	}

	return Array.from(new Set(normalizedPaths));
}

/** Convert a path argument into stable relative/absolute candidates for glob checks. */
export function normalizeTtsrPathCandidates(rawPath: string, cwd: string): string[] {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		return [];
	}

	const normalizedInput = trimmed.replaceAll("\\", "/");
	const candidates = new Set<string>([normalizedInput]);
	if (normalizedInput.startsWith("./")) {
		candidates.add(normalizedInput.slice(2));
	}

	const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
	candidates.add(absolutePath.replaceAll("\\", "/"));

	const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
	if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
		candidates.add(relativePath);
	}

	return Array.from(candidates);
}
