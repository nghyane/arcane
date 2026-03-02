import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolCallContext,
} from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { untilAborted } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import type { ToolSession } from "../sdk";
import { getLanguageFromPath, type Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import {
	formatClickHint,
	formatDiagnostics,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../ui/render-utils";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { type OutputMeta, outputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";

const writeSchema = Type.Object({
	path: Type.String({ description: "File path (relative or absolute)" }),
	content: Type.String({ description: "Complete file content to write" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
}

const LSP_BATCH_TOOLS = new Set(["edit", "write"]);

function getLspBatchRequest(toolCall: ToolCallContext | undefined): { id: string; flush: boolean } | undefined {
	if (!toolCall) {
		return undefined;
	}
	const hasOtherWrites = toolCall.toolCalls.some(
		(call, index) => index !== toolCall.index && LSP_BATCH_TOOLS.has(call.name),
	);
	if (!hasOtherWrites) {
		return undefined;
	}
	const hasLaterWrites = toolCall.toolCalls.slice(toolCall.index + 1).some(call => LSP_BATCH_TOOLS.has(call.name));
	return { id: toolCall.batchId, flush: !hasLaterWrites };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails, Theme> {
	readonly name = "write";
	readonly label = "Write";
	description = "Create a new file";
	readonly parameters = writeSchema;
	readonly nonAbortable = true;
	readonly concurrency = "exclusive";

	readonly #writethrough: WritethroughCallback;

	constructor(private readonly session: ToolSession) {
		const enableLsp = session.enableLsp ?? true;
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		this.#writethrough = enableLsp
			? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics })
			: writethroughNoop;
	}

	async execute(
		_toolCallId: string,
		{ path, content }: WriteParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		return untilAborted(signal, async () => {
			const absolutePath = resolveToCwd(path, this.session.cwd);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			const diagnostics = await this.#writethrough(absolutePath, content, signal, undefined, batchRequest);
			invalidateFsScanAfterWrite(absolutePath);

			const resultText = `Successfully wrote ${content.length} bytes to ${path}`;
			if (!diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: {},
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					diagnostics,
					meta: outputMeta()
						.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}

	renderCall(args: WriteRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(rawPath) ?? "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";

		const title = uiTheme.fg("toolTitle", uiTheme.bold("Write"));
		let text = `${title} ${spinner ? `${spinner} ` : ""}${langIcon} ${pathDisplay}`;

		if (!args.content) {
			return new Text(text, 0, 0);
		}

		// Show streaming preview of content (tail)
		text += formatStreamingContent(args.content, uiTheme);

		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const fileContent = args?.content || "";
		const lang = getLanguageFromPath(rawPath);
		const lineCount = countLines(fileContent);
		const diagnostics = result.details?.diagnostics;

		const meta: string[] = [];
		if (lineCount > 0) meta.push(`${lineCount} lines`);
		if (lang) meta.push(lang);

		const header = renderStatusLine(
			{ icon: "success", title: "Write", description: filePath || "file", meta },
			uiTheme,
		);

		// Tree-style content preview
		const lines = fileContent ? fileContent.split("\n") : [];
		const expanded = options.expanded;
		const displayLines = expanded ? lines : lines.slice(-PREVIEW_LIMITS.WRITE_TAIL);
		const skipped = lines.length - displayLines.length;

		const bodyLines: string[] = [];
		if (displayLines.length > 0) {
			if (skipped > 0) {
				bodyLines.push(uiTheme.fg("dim", `… ${skipped} more lines`));
			}
			for (let i = 0; i < displayLines.length; i++) {
				bodyLines.push(uiTheme.fg("toolOutput", replaceTabs(displayLines[i])));
			}
		}

		if (diagnostics) {
			const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, (fp: string) =>
				uiTheme.getLangIcon(getLanguageFromPath(fp)),
			);
			if (diagText.trim()) bodyLines.push(diagText.trim());
		}

		const all = bodyLines.length > 0 ? [header, ...bodyLines] : [header];
		return new Text(all.join("\n"), 0, 0);
	}
}

interface WriteRenderArgs {
	path?: string;
	file_path?: string;
	content?: string;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatStreamingContent(content: string, uiTheme: Theme): string {
	if (!content) return "";
	const lines = content.split("\n");
	const displayLines = lines.slice(-PREVIEW_LIMITS.EXPANDED_LINES);
	const hidden = lines.length - displayLines.length;

	let text = "\n\n";
	if (hidden > 0) {
		text += uiTheme.fg("dim", `… (${hidden} earlier lines)\n`);
	}
	for (const line of displayLines) {
		text += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.CONTENT))}\n`;
	}
	text += uiTheme.fg("dim", `… (streaming)`);
	return text;
}
