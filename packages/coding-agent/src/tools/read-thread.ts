import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { Api, Model } from "@nghyane/arcane-ai";
import { completeSimple } from "@nghyane/arcane-ai";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { logger, parseJsonlLenient } from "@nghyane/arcane-utils";
import { getSessionsDir } from "@nghyane/arcane-utils/dirs";
import { type Static, Type } from "@sinclair/typebox";
import { parseModelString } from "../config/model-resolver";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import extractPrompt from "../prompts/thread-extract.md" with { type: "text" };
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { PREVIEW_LIMITS, truncateToWidth } from "../ui/render-utils";
import type { ToolSession } from ".";

const readThreadSchema = Type.Object({
	threadId: Type.String({ description: "Session/thread ID to read" }),
	goal: Type.String({ description: "What information to extract from the thread. Be specific." }),
});

type ReadThreadParams = Static<typeof readThreadSchema>;

export interface ReadThreadToolDetails {
	threadId: string;
	goal: string;
	title?: string;
	originalLength: number;
	extractedLength: number;
	compressionRatio: number;
}

interface ReadThreadRenderArgs {
	threadId?: string;
	goal?: string;
}

interface MessageContent {
	type?: string;
	text?: string;
	name?: string;
	input?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

interface RawSessionEntry {
	type?: string;
	id?: string;
	title?: string;
	message?: {
		role?: string;
		content?: string | MessageContent[];
		toolName?: string;
		isError?: boolean;
	};
}

async function findSessionFile(threadId: string): Promise<{ file: string; title?: string } | null> {
	const sessionsDir = getSessionsDir();
	let subdirs: string[];
	try {
		subdirs = fs.readdirSync(sessionsDir);
	} catch {
		return null;
	}

	for (const subdir of subdirs) {
		const dirPath = path.join(sessionsDir, subdir);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(dirPath);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;

		let files: string[];
		try {
			files = fs.readdirSync(dirPath);
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const filePath = path.join(dirPath, file);
			try {
				const fd = fs.openSync(filePath, "r");
				const buf = Buffer.alloc(4096);
				const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
				fs.closeSync(fd);
				const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n")[0];
				if (!firstLine) continue;
				const header = JSON.parse(firstLine) as RawSessionEntry;
				if (header.type === "session" && header.id === threadId) {
					return { file: filePath, title: header.title };
				}
			} catch {}
		}
	}
	return null;
}

function renderSessionMarkdown(entries: RawSessionEntry[]): { markdown: string; turnCount: number } {
	const parts: string[] = [];
	let turnCount = 0;

	for (const entry of entries) {
		if (entry.type === "session") continue;
		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (!msg?.role) continue;
		const role = msg.role;
		if (!["user", "assistant", "toolResult"].includes(role)) continue;

		if (role === "user") {
			turnCount++;
			const text = typeof msg.content === "string" ? msg.content : "";
			parts.push(`## User\n\n${text}\n`);
		} else if (role === "assistant") {
			turnCount++;
			if (typeof msg.content === "string") {
				parts.push(`## Assistant\n\n${msg.content}\n`);
			} else if (Array.isArray(msg.content)) {
				const blocks: string[] = [];
				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						blocks.push(block.text);
					} else if (block.type === "toolCall" || block.type === "tool_use") {
						const name = block.name ?? "unknown";
						const input = block.arguments ?? block.input;
						let argSummary = "";
						if (input && typeof input === "object") {
							const argParts: string[] = [];
							for (const [k, v] of Object.entries(input)) {
								const val = typeof v === "string" ? v : JSON.stringify(v);
								argParts.push(`${k}: ${val.length > 200 ? `${val.slice(0, 200)}...` : val}`);
							}
							argSummary = argParts.join("\n");
						}
						blocks.push(`**Tool: ${name}**\n${argSummary}`);
					}
				}
				if (blocks.length > 0) {
					parts.push(`## Assistant\n\n${blocks.join("\n\n")}\n`);
				}
			}
		} else if (role === "toolResult") {
			const toolName = msg.toolName ?? "unknown";
			const isError = msg.isError === true;
			if (typeof msg.content === "string") {
				const text = msg.content;
				if (isError) {
					parts.push(`**Error (${toolName}):**\n${text}\n`);
				} else if (text.length > 500) {
					parts.push(
						`**Result (${toolName}):**\n${text.slice(0, 300)}... [truncated, ${text.length} chars total]\n`,
					);
				} else {
					parts.push(`**Result (${toolName}):**\n${text}\n`);
				}
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					const text = block.text ?? "";
					if (isError) {
						parts.push(`**Error (${toolName}):**\n${text}\n`);
					} else if (text.length > 500) {
						parts.push(
							`**Result (${toolName}):**\n${text.slice(0, 300)}... [truncated, ${text.length} chars total]\n`,
						);
					} else {
						parts.push(`**Result (${toolName}):**\n${text}\n`);
					}
				}
			}
		}
	}

	return { markdown: parts.join("\n"), turnCount };
}

function truncateTurns(markdown: string, turnCount: number): string {
	if (turnCount <= 40) return markdown;

	const lines = markdown.split("\n");
	const turnStarts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## User") || lines[i].startsWith("## Assistant")) {
			turnStarts.push(i);
		}
	}

	if (turnStarts.length <= 40) return markdown;

	const keepFirst = 20;
	const keepLast = 20;
	const firstEnd = turnStarts[keepFirst];
	const lastStart = turnStarts[turnStarts.length - keepLast];
	const omitted = turnStarts.length - keepFirst - keepLast;

	const head = lines.slice(0, firstEnd).join("\n");
	const tail = lines.slice(lastStart).join("\n");
	return `${head}\n\n---\n[... ${omitted} turns omitted ...]\n---\n\n${tail}`;
}

export class ReadThreadTool implements AgentTool<typeof readThreadSchema, ReadThreadToolDetails, Theme> {
	readonly name = "read_thread";
	readonly label = "Read Thread";
	description = [
		"Read and extract relevant content from a past conversation thread by its ID.",
		"Uses AI to extract only information relevant to your goal, keeping context concise.",
		"Use find_thread first to discover thread IDs.",
		"",
		'Goal tips: be specific ("what auth approach was chosen" not "tell me about auth").',
		"",
		"Examples:",
		'- read_thread(id, "Extract the implementation plan and design decisions")',
		'- read_thread(id, "Extract the bug fix, root cause, and relevant code changes")',
	].join("\n");
	readonly parameters = readThreadSchema;
	readonly concurrency = "shared" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: ReadThreadParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadThreadToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ReadThreadToolDetails>> {
		const { threadId, goal } = params;

		// Find session file
		const found = await findSessionFile(threadId);
		if (!found) {
			return {
				content: [{ type: "text", text: `Thread "${threadId}" not found.` }],
				details: { threadId, goal, originalLength: 0, extractedLength: 0, compressionRatio: 1 },
			};
		}

		const { file: sessionFile, title } = found;

		// Load and parse JSONL
		const content = await Bun.file(sessionFile).text();
		const entries = parseJsonlLenient<RawSessionEntry>(content);

		// Render to markdown
		const { markdown: rawMarkdown, turnCount } = renderSessionMarkdown(entries);
		const markdown = truncateTurns(rawMarkdown, turnCount);

		if (markdown.length === 0) {
			return {
				content: [{ type: "text", text: `Thread "${threadId}" is empty.` }],
				details: { threadId, goal, title, originalLength: 0, extractedLength: 0, compressionRatio: 1 },
			};
		}

		// Resolve extraction model
		const registry = this.session.subagentContext?.modelRegistry;
		if (!registry) {
			return {
				content: [{ type: "text", text: `No model registry available. Cannot extract content.` }],
				details: {
					threadId,
					goal,
					title,
					originalLength: markdown.length,
					extractedLength: 0,
					compressionRatio: 0,
				},
			};
		}

		const fastModelId = this.session.settings.getModelRole("fast") ?? this.session.settings.getModelRole("default");
		const availableModels = registry.getAvailable();
		let model: Model<Api> | undefined;

		if (fastModelId) {
			const parsed = parseModelString(fastModelId);
			if (parsed) {
				model = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			}
		}
		if (!model) {
			model = availableModels[0];
		}
		if (!model) {
			return {
				content: [{ type: "text", text: "No model available for extraction." }],
				details: {
					threadId,
					goal,
					title,
					originalLength: markdown.length,
					extractedLength: 0,
					compressionRatio: 0,
				},
			};
		}

		const sessionId = this.session.getSessionId?.() ?? undefined;
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) {
			return {
				content: [{ type: "text", text: "No API key available for extraction model." }],
				details: {
					threadId,
					goal,
					title,
					originalLength: markdown.length,
					extractedLength: 0,
					compressionRatio: 0,
				},
			};
		}

		// Call LLM for extraction
		let relevantContent: string;
		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: extractPrompt,
					messages: [
						{
							role: "user",
							content: `Here is the thread content:\n\n<thread>\n${markdown}\n</thread>\n\nGoal: ${goal}`,
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey, maxTokens: 8192 },
			);

			let text = "";
			for (const block of response.content) {
				if (block.type === "text") {
					text += block.text;
				}
			}
			relevantContent = text.trim();

			if (!relevantContent) {
				relevantContent = "No relevant content extracted.";
			}
		} catch (err) {
			logger.error("read_thread: extraction failed", { error: err instanceof Error ? err.message : String(err) });
			return {
				content: [{ type: "text", text: `Extraction failed: ${err instanceof Error ? err.message : String(err)}` }],
				details: {
					threadId,
					goal,
					title,
					originalLength: markdown.length,
					extractedLength: 0,
					compressionRatio: 0,
				},
			};
		}

		const originalLength = markdown.length;
		const extractedLength = relevantContent.length;
		const compressionRatio = originalLength > 0 ? extractedLength / originalLength : 1;
		logger.debug("read_thread compression", { originalLength, extractedLength, compressionRatio });

		return {
			content: [{ type: "text", text: relevantContent }],
			details: { threadId, goal, title, originalLength, extractedLength, compressionRatio },
		};
	}

	renderCall(args: ReadThreadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta = args.threadId ? [args.threadId] : [];
		const text = renderStatusLine({ icon: "pending", title: "Read Thread", meta }, uiTheme);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadThreadToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: ReadThreadRenderArgs,
	): Component {
		const details = result.details;
		const titlePart = details?.title ? ` — ${details.title}` : "";
		const compressionPart = details ? ` (${Math.round(details.compressionRatio * 100)}% of original)` : "";
		const header = renderStatusLine(
			{ icon: "success", title: "Read Thread", meta: [`${titlePart}${compressionPart}`] },
			uiTheme,
		);

		const contentText = result.content?.find(c => c.type === "text")?.text ?? "No content";
		const { expanded } = options;
		const maxLines = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
		const lines = contentText.split("\n").slice(0, maxLines);
		const truncated = lines.map(line => truncateToWidth(line, 120)).join("\n");
		const preview = uiTheme.fg("dim", truncated);

		return new Text(`${header}\n${preview}`, 0, 0);
	}
}
