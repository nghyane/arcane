/**
 * Shared utilities for edit tool TUI rendering.
 */
import type { ToolCallContext } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { FileDiagnosticsResult } from "../lsp";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { getLanguageFromPath, type Theme } from "../theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import { renderStatusLine } from "../tui";
import {
	formatClickHint,
	formatDiagnostics,
	formatStatusIcon,
	getDiffStats,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../ui/render-utils";
import type { DiffError, DiffResult, Operation } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// LSP Batching
// ═══════════════════════════════════════════════════════════════════════════

const LSP_BATCH_TOOLS = new Set(["edit", "write"]);

export function getLspBatchRequest(toolCall: ToolCallContext | undefined): { id: string; flush: boolean } | undefined {
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
// Tool Details Types
// ═══════════════════════════════════════════════════════════════════════════

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	rename?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Renderer
// ═══════════════════════════════════════════════════════════════════════════

interface EditRenderArgs {
	path?: string;
	file_path?: string;
	oldText?: string;
	newText?: string;
	patch?: string;
	all?: boolean;
	// Patch mode fields
	op?: Operation;
	rename?: string;
	diff?: string;
	/**
	 * Computed preview diff (used when tool args don't include a diff, e.g. hashline mode).
	 */
	previewDiff?: string;
	// Hashline mode fields
	edits?: HashlineEditPreview[];
}

type HashlineEditPreview =
	| { op: "replace"; target: string; end?: string; content: string[] | string | null }
	| { op: "insert"; target: string; position: "before" | "after"; content: string[] | string };

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: DiffResult | DiffError;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

const EDIT_STREAMING_PREVIEW_LINES = 12;

function formatStreamingDiff(diff: string, rawPath: string, uiTheme: Theme, label = "streaming"): string {
	if (!diff) return "";
	const lines = diff.split("\n");
	const total = lines.length;
	const displayLines = lines.slice(-EDIT_STREAMING_PREVIEW_LINES);
	const hidden = total - displayLines.length;
	let text = "\n\n";
	if (hidden > 0) {
		text += uiTheme.fg("dim", `… (${hidden} earlier lines)\n`);
	}
	text += renderDiffColored(displayLines.join("\n"), { filePath: rawPath });
	text += uiTheme.fg("dim", `\n… (${label})`);
	return text;
}

function formatStreamingHashlineEdits(edits: unknown[], uiTheme: Theme): string {
	const MAX_EDITS = 4;
	const MAX_DST_LINES = 8;
	let text = "\n\n";
	text += uiTheme.fg("dim", `[${edits.length} hashline edit${edits.length === 1 ? "" : "s"}]`);
	text += "\n";
	let shownEdits = 0;
	let shownDstLines = 0;
	for (const edit of edits) {
		shownEdits++;
		if (shownEdits > MAX_EDITS) break;
		const formatted = formatHashlineEdit(edit);
		text += uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(formatted.srcLabel), TRUNCATE_LENGTHS.LONG));
		text += "\n";
		if (formatted.dst === "") {
			text += uiTheme.fg("dim", truncateToWidth("  (delete)", TRUNCATE_LENGTHS.LONG));
			text += "\n";
			continue;
		}
		for (const dstLine of formatted.dst.split("\n")) {
			shownDstLines++;
			if (shownDstLines > MAX_DST_LINES) break;
			text += uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(`+ ${dstLine}`), TRUNCATE_LENGTHS.LONG));
			text += "\n";
		}
		if (shownDstLines > MAX_DST_LINES) break;
	}
	if (edits.length > MAX_EDITS) {
		text += uiTheme.fg("dim", `… (${edits.length - MAX_EDITS} more edits)`);
	}
	if (shownDstLines > MAX_DST_LINES) {
		text += uiTheme.fg("dim", `\n… (${shownDstLines - MAX_DST_LINES} more dst lines)`);
	}

	return text.trimEnd();
	function formatHashlineEdit(edit: unknown): { srcLabel: string; dst: string } {
		const asRecord = (value: unknown): Record<string, unknown> | undefined => {
			if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
			return undefined;
		};
		const editRecord = asRecord(edit);
		if (!editRecord) {
			return {
				srcLabel: "• (incomplete edit)",
				dst: "",
			};
		}
		const op = editRecord.op;
		const target = typeof editRecord.target === "string" ? editRecord.target : "…";
		const content = editRecord.content;
		const contentStr =
			content === null
				? ""
				: Array.isArray(content)
					? (content as string[]).join("\n")
					: typeof content === "string"
						? content
						: "";
		if (op === "replace") {
			const end = typeof editRecord.end === "string" ? editRecord.end : undefined;
			return {
				srcLabel: end ? `• range ${target}..${end}` : `• line ${target}`,
				dst: contentStr,
			};
		}
		if (op === "insert") {
			const position = typeof editRecord.position === "string" ? editRecord.position : "after";
			return {
				srcLabel: `• insert ${position} ${target}`,
				dst: contentStr,
			};
		}
		return {
			srcLabel: "• (incomplete edit)",
			dst: "",
		};
	}
}

export const editToolRenderer = {
	renderCall(
		args: EditRenderArgs,
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
	): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const editLanguage = getLanguageFromPath(rawPath) ?? "text";
		const editIcon = uiTheme.fg("muted", uiTheme.getLangIcon(editLanguage));
		let pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");

		// Add arrow for move/rename operations
		if (args.rename) {
			pathDisplay += ` ${uiTheme.fg("dim", "→")} ${uiTheme.fg("accent", shortenPath(args.rename))}`;
		}

		// Show operation type for patch mode
		const opTitle = args.op === "create" ? "Create" : args.op === "delete" ? "Delete" : "Edit";
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";
		const title = uiTheme.fg("toolTitle", uiTheme.bold(opTitle));
		let text = `${title} ${spinner ? `${spinner} ` : ""}${editIcon} ${pathDisplay}`;

		// Show streaming preview of diff/content
		const previewDiffText =
			args.previewDiff ??
			(options.renderContext?.editDiffPreview && "diff" in options.renderContext.editDiffPreview
				? options.renderContext.editDiffPreview.diff
				: undefined);
		if (previewDiffText) {
			text += formatStreamingDiff(previewDiffText, rawPath, uiTheme, "preview");
		} else if (args.diff && args.op) {
			text += formatStreamingDiff(args.diff, rawPath, uiTheme);
		} else if (args.edits && args.edits.length > 0) {
			text += formatStreamingHashlineEdits(args.edits, uiTheme);
		} else if (args.diff) {
			const previewLines = args.diff.split("\n");
			text += "\n\n";
			for (const line of previewLines.slice(0, PREVIEW_LIMITS.STREAMING_PREVIEW)) {
				text += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.CONTENT))}\n`;
			}
			if (previewLines.length > PREVIEW_LIMITS.STREAMING_PREVIEW) {
				text += uiTheme.fg("dim", `… ${previewLines.length - PREVIEW_LIMITS.STREAMING_PREVIEW} more lines`);
			}
		} else if (args.newText || args.patch) {
			const previewLines = (args.newText ?? args.patch ?? "").split("\n");
			text += "\n\n";
			for (const line of previewLines.slice(0, PREVIEW_LIMITS.STREAMING_PREVIEW)) {
				text += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.CONTENT))}\n`;
			}
			if (previewLines.length > PREVIEW_LIMITS.STREAMING_PREVIEW) {
				text += uiTheme.fg("dim", `… ${previewLines.length - PREVIEW_LIMITS.STREAMING_PREVIEW} more lines`);
			}
		}

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const op = args?.op || result.details?.op;
		const rename = args?.rename || result.details?.rename;
		const opTitle = op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			const header = renderStatusLine({ icon: "error", title: opTitle, description: filePath || "file" }, uiTheme);
			return new Text(`${header}\n${uiTheme.fg("error", replaceTabs(errorText))}`, 0, 0);
		}

		// Get diff text from result or preview
		const { renderContext } = options;
		const editDiffPreview = renderContext?.editDiffPreview;
		const diffText =
			result.details?.diff ??
			(editDiffPreview && "diff" in editDiffPreview ? editDiffPreview.diff : undefined) ??
			"";

		const diffStats = diffText ? getDiffStats(diffText) : { added: 0, removed: 0, hunks: 0, lines: 0 };

		// Build header with diff stats
		let description = filePath || "file";
		if (rename) description += ` ${uiTheme.fg("dim", "→")} ${shortenPath(rename)}`;
		const meta: string[] = [];
		if (diffStats.hunks > 0) meta.push(`${diffStats.hunks} hunks`);
		if (diffStats.added > 0) meta.push(uiTheme.fg("success", `+${diffStats.added}`));
		if (diffStats.removed > 0) meta.push(uiTheme.fg("error", `-${diffStats.removed}`));

		const header = renderStatusLine({ icon: "success", title: opTitle, description, meta }, uiTheme);

		// Tree-style diff body
		const expanded = options.expanded;
		const diffLines = diffText ? diffText.split("\n") : [];
		const maxLines = expanded ? diffLines.length : Math.min(diffLines.length, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);

		const treeBody: string[] = [];
		for (let i = 0; i < maxLines; i++) {
			const line = diffLines[i];
			const color = line.startsWith("+") ? "success" : line.startsWith("-") ? "error" : "dim";
			treeBody.push(uiTheme.fg(color, replaceTabs(line)));
		}
		if (!expanded && diffLines.length > maxLines) {
			const remaining = diffLines.length - maxLines;
			treeBody.push(`${uiTheme.fg("dim", `… ${remaining} more lines`)} ${formatClickHint(uiTheme)}`);
		}

		// Diagnostics
		if (result.details?.diagnostics) {
			const diagText = formatDiagnostics(result.details.diagnostics, expanded, uiTheme, (fp: string) =>
				uiTheme.getLangIcon(getLanguageFromPath(fp)),
			);
			if (diagText.trim()) treeBody.push(diagText.trim());
		}

		const all = treeBody.length > 0 ? [header, ...treeBody] : [header];
		return new Text(all.join("\n"), 0, 0);
	},
};
