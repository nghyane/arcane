import type { AgentMessage, AgentState } from "@nghyane/arcane-agent";
import type { AssistantMessage, Model, Usage, UsageReport } from "@nghyane/arcane-ai";
import type { ModelRegistry } from "../config/model-registry";
import { exportSessionToHtml } from "../export/html";
import type { ContextUsage } from "../extensibility/extensions/types";
import { getCurrentThemeName } from "../theme/theme";
import { calculateContextTokens, estimateTokens } from "./compaction";
import type { FileMentionMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import type { SessionStats } from "./session-types";

/**
 * Compute session statistics from messages.
 */
export function getSessionStats(
	messages: AgentMessage[],
	sessionFile: string | undefined,
	sessionId: string,
): SessionStats {
	const userMessages = messages.filter(m => m.role === "user").length;
	const assistantMessages = messages.filter(m => m.role === "assistant").length;
	const toolResults = messages.filter(m => m.role === "toolResult").length;

	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	const getTaskToolUsage = (details: unknown): Usage | undefined => {
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const usage = record.usage;
		if (!usage || typeof usage !== "object") return undefined;
		return usage as Usage;
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
			totalInput += assistantMsg.usage.input;
			totalOutput += assistantMsg.usage.output;
			totalCacheRead += assistantMsg.usage.cacheRead;
			totalCacheWrite += assistantMsg.usage.cacheWrite;
			totalCost += assistantMsg.usage.cost.total;
		}

		if (message.role === "toolResult" && message.toolName === "task") {
			const usage = getTaskToolUsage(message.details);
			if (usage) {
				totalInput += usage.input;
				totalOutput += usage.output;
				totalCacheRead += usage.cacheRead;
				totalCacheWrite += usage.cacheWrite;
				totalCost += usage.cost.total;
			}
		}
	}

	return {
		sessionFile,
		sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: messages.length,
		tokens: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
		},
		cost: totalCost,
	};
}

/**
 * Get current context usage statistics.
 */
export function getContextUsage(model: Model | undefined, messages: AgentMessage[]): ContextUsage | undefined {
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	const { tokens } = estimateContextTokensFromMessages(messages);
	const percent = Math.round((tokens / contextWindow) * 100);

	return {
		tokens,
		contextWindow,
		percent,
	};
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 */
export function estimateContextTokensFromMessages(messages: AgentMessage[]): { tokens: number } {
	let lastUsageIndex: number | null = null;
	let lastUsage: Usage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.usage) {
				lastUsage = assistantMsg.usage;
				lastUsageIndex = i;
				break;
			}
		}
	}

	if (!lastUsage || lastUsageIndex === null) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return { tokens: estimated };
	}

	const usageTokens = calculateContextTokens(lastUsage);
	let trailingTokens = 0;
	for (let i = lastUsageIndex + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return { tokens: usageTokens + trailingTokens };
}

/**
 * Fetch usage reports from the auth storage.
 */
export function fetchUsageReports(modelRegistry: ModelRegistry): Promise<UsageReport[] | null> | null {
	const authStorage = modelRegistry.authStorage;
	if (!authStorage.fetchUsageReports) return null;
	return authStorage.fetchUsageReports({
		baseUrlResolver: provider => modelRegistry.getProviderBaseUrl?.(provider),
	});
}

/**
 * Export session to HTML.
 */
export async function exportToHtml(
	sessionManager: SessionManager,
	state: AgentState,
	outputPath?: string,
): Promise<string> {
	const themeName = getCurrentThemeName();
	return exportSessionToHtml(sessionManager, state, { outputPath, themeName });
}

/**
 * Get text content of last assistant message.
 */
export function getLastAssistantText(messages: AgentMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find(m => {
			if (m.role !== "assistant") return false;
			const msg = m as AssistantMessage;
			if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}

/**
 * Format the entire session as plain text for clipboard export.
 */
export function formatSessionAsText(state: AgentState): string {
	const lines: string[] = [];

	function formatArgsAsXml(args: Record<string, unknown>, indent = "\t"): string {
		const parts: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			parts.push(`${indent}<parameter name="${key}">${text}</parameter>`);
		}
		return parts.join("\n");
	}

	const systemPrompt = state.systemPrompt;
	if (systemPrompt) {
		lines.push("## System Prompt\n");
		lines.push(systemPrompt);
		lines.push("\n");
	}

	const model = state.model;
	const thinkingLevel = state.thinkingLevel;
	lines.push("## Configuration\n");
	lines.push(`Model: ${model.provider}/${model.id}`);
	lines.push(`Thinking Level: ${thinkingLevel}`);
	lines.push("\n");

	const tools = state.tools;

	// Recursively strip all fields starting with 'TypeBox.' from an object
	function stripTypeBoxFields(obj: unknown): unknown {
		if (Array.isArray(obj)) {
			return obj.map(stripTypeBoxFields);
		}
		if (obj && typeof obj === "object") {
			const result: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(obj)) {
				if (!k.startsWith("TypeBox.")) {
					result[k] = stripTypeBoxFields(v);
				}
			}
			return result;
		}
		return obj;
	}

	if (tools.length > 0) {
		lines.push("## Available Tools\n");
		for (const tool of tools) {
			lines.push(`<tool name="${tool.name}">`);
			lines.push(tool.description);
			const parametersClean = stripTypeBoxFields(tool.parameters);
			lines.push(`\nParameters:\n${formatArgsAsXml(parametersClean as Record<string, unknown>)}`);
			lines.push("<" + "/tool>\n");
		}
		lines.push("\n");
	}

	for (const msg of state.messages) {
		if (msg.role === "user") {
			lines.push("## User\n");
			if (typeof msg.content === "string") {
				lines.push(msg.content);
			} else {
				for (const c of msg.content) {
					if (c.type === "text") {
						lines.push(c.text);
					} else if (c.type === "image") {
						lines.push("[Image]");
					}
				}
			}
			lines.push("\n");
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			lines.push("## Assistant\n");

			for (const c of assistantMsg.content) {
				if (c.type === "text") {
					lines.push(c.text);
				} else if (c.type === "thinking") {
					lines.push("<thinking>");
					lines.push(c.thinking);
					lines.push("</thinking>\n");
				} else if (c.type === "toolCall") {
					lines.push(`<tool_call name="${c.name}" id="${c.id}">`);
					if (c.arguments && typeof c.arguments === "object") {
						lines.push(formatArgsAsXml(c.arguments as Record<string, unknown>));
					}
					lines.push("<" + "/tool_call>\n");
				}
			}
			lines.push("\n");
		} else if (msg.role === "toolResult") {
			lines.push(`## Tool Result [${msg.toolName}] (id: ${msg.toolCallId})\n`);
			if (typeof msg.content === "string") {
				lines.push(msg.content);
			} else if (Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (c.type === "text") {
						lines.push(c.text);
					} else if (c.type === "image") {
						lines.push("[Image]");
					}
				}
			}
			lines.push("\n");
		}
	}

	return lines.join("\n").trim();
}

/**
 * Format the conversation as compact context for subagents.
 */
export function formatCompactContext(messages: AgentMessage[]): string {
	const lines: string[] = [];
	lines.push("# Conversation Context");
	lines.push("");
	lines.push(
		"This is a summary of the parent conversation. Read this if you need additional context about what was discussed or decided.",
	);
	lines.push("");

	for (const msg of messages) {
		if (msg.role === "user") {
			lines.push("## User");
			lines.push("");
			if (typeof msg.content === "string") {
				lines.push(msg.content);
			} else {
				for (const c of msg.content) {
					if (c.type === "text") {
						lines.push(c.text);
					} else if (c.type === "image") {
						lines.push("[Image attached]");
					}
				}
			}
			lines.push("");
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const textParts: string[] = [];
			for (const c of assistantMsg.content) {
				if (c.type === "text" && c.text.trim()) {
					textParts.push(c.text);
				}
			}
			if (textParts.length > 0) {
				lines.push("## Assistant");
				lines.push("");
				lines.push(textParts.join("\n\n"));
				lines.push("");
			}
		} else if (msg.role === "fileMention") {
			const fileMsg = msg as FileMentionMessage;
			const paths = fileMsg.files.map(f => f.path).join(", ");
			lines.push(`[Files referenced: ${paths}]`);
			lines.push("");
		}
	}

	return lines.join("\n").trim();
}
