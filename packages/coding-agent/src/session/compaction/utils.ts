/**
 * Shared utilities for branch summarization.
 */
import type { AgentMessage } from "@nghyane/arcane-agent";
import type { AssistantMessage, Message, Usage } from "@nghyane/arcane-ai";
import { renderPromptTemplate } from "../../config/prompt-templates";
import fileOperationsTemplate from "../../prompts/system/file-operations.md" with { type: "text" };
import summarizationSystemPrompt from "../../prompts/system/summarization-system.md" with { type: "text" };

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter(f => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
const FILE_OPERATION_SUMMARY_LIMIT = 20;

function truncateFileList(files: string[]): string[] {
	if (files.length <= FILE_OPERATION_SUMMARY_LIMIT) return files;
	const omitted = files.length - FILE_OPERATION_SUMMARY_LIMIT;
	return [...files.slice(0, FILE_OPERATION_SUMMARY_LIMIT), `… (${omitted} more files omitted)`];
}

function stripFileOperationTags(summary: string): string {
	const withoutReadFiles = summary.replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "");
	const withoutModifiedFiles = withoutReadFiles.replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "");
	return withoutModifiedFiles.trimEnd();
}
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	return renderPromptTemplate(fileOperationsTemplate, {
		readFiles: truncateFileList(readFiles),
		modifiedFiles: truncateFileList(modifiedFiles),
	});
}

export function upsertFileOperations(summary: string, readFiles: string[], modifiedFiles: string[]): string {
	const baseSummary = stripFileOperationTags(summary);
	const fileOperations = formatFileOperations(readFiles, modifiedFiles);
	if (!fileOperations) return baseSummary;
	if (!baseSummary) return fileOperations;
	return `${baseSummary}\n\n${fileOperations}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${content}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = renderPromptTemplate(summarizationSystemPrompt);

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "hookMessage":
		case "toolResult": {
			if (typeof message.content === "string") {
				chars = message.content.length;
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
					if (block.type === "image") {
						chars += 4800; // Estimate images as 4000 chars, or 1200 tokens
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

// ============================================================================
// Context Token Calculation
// ============================================================================

/**
 * Calculate context tokens from usage report.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get the last assistant message's usage data.
 */
export function getLastAssistantUsage(messages: AgentMessage[]): Usage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return (msg as AssistantMessage).usage;
		}
	}
	return undefined;
}
