/**
 * LSP Tool TUI Rendering
 */
import type { RenderResultOptions } from "@nghyane/arcane-agent";
import { type Component, Text } from "@nghyane/arcane-tui";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatCount, formatErrorMessage, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../ui/render-utils";
import type { LspParams, LspToolDetails } from "./types";

// =============================================================================
// Call Rendering
// =============================================================================

/**
 * Render the LSP tool call in the TUI.
 * Shows: "lsp <operation> <file/filecount>"
 */
export function renderCall(args: LspParams, _options: RenderResultOptions, theme: Theme): Text {
	const actionLabel = (args.action ?? "request").replace(/_/g, " ");
	const queryPreview = args.query ? truncateToWidth(args.query, TRUNCATE_LENGTHS.SHORT) : undefined;

	let target: string | undefined;
	let hasFileTarget = false;

	if (args.file) {
		target = shortenPath(args.file);
		hasFileTarget = true;
	} else if (args.files?.length === 1) {
		target = shortenPath(args.files[0]);
		hasFileTarget = true;
	} else if (args.files?.length) {
		target = `${args.files.length} files`;
	}

	if (hasFileTarget && args.line !== undefined) {
		const col = args.column !== undefined ? `:${args.column}` : "";
		target += `:${args.line}${col}`;
		if (args.end_line !== undefined) {
			const endCol = args.end_character !== undefined ? `:${args.end_character}` : "";
			target += `-${args.end_line}${endCol}`;
		}
	} else if (!target && args.line !== undefined) {
		const col = args.column !== undefined ? `:${args.column}` : "";
		target = `line ${args.line}${col}`;
		if (args.end_line !== undefined) {
			const endCol = args.end_character !== undefined ? `:${args.end_character}` : "";
			target += `-${args.end_line}${endCol}`;
		}
	}

	const meta: string[] = [];
	if (queryPreview && target) meta.push(`query:${queryPreview}`);
	if (args.new_name) meta.push(`new:${args.new_name}`);
	if (args.apply !== undefined) meta.push(`apply:${args.apply ? "true" : "false"}`);
	if (args.include_declaration !== undefined) {
		meta.push(`include_decl:${args.include_declaration ? "true" : "false"}`);
	}

	const descriptionParts = [actionLabel];
	if (target) {
		descriptionParts.push(target);
	} else if (queryPreview) {
		descriptionParts.push(queryPreview);
	}

	const text = renderStatusLine(
		{
			icon: "pending",
			title: "LSP",
			description: descriptionParts.join(" "),
			meta,
		},
		theme,
	);

	return new Text(text, 0, 0);
}

// =============================================================================
// Result Rendering
// =============================================================================

/**
 * Render LSP tool result as a single dim status line.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: LspToolDetails; isError?: boolean },
	_options: RenderResultOptions,
	theme: Theme,
	args?: LspParams & { file?: string; files?: string[] },
): Component {
	const content = result.content?.[0];
	const text = content?.type === "text" ? (content.text ?? "") : "";

	if (result.isError || text.startsWith("Error:")) {
		const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
		return new Text(formatErrorMessage(errorText, theme), 0, 0);
	}

	const request = args ?? result.details?.request;
	const action = (request?.action ?? result.details?.action ?? "request").replace(/_/g, " ");
	const meta: string[] = [];

	// Extract counts from result text
	const errorMatch = text.match(/(\d+)\s+error\(s\)/);
	const warningMatch = text.match(/(\d+)\s+warning\(s\)/);
	const refMatch = text.match(/(\d+)\s+reference\(s\)/);
	const renameMatch = text.match(/Applied.*?(\d+)\s+file/);

	let description = "";
	if (request?.file) {
		description = shortenPath(request.file);
		if (request.line !== undefined) description += `:${request.line}`;
	} else if (request?.files?.length === 1) {
		description = shortenPath(request.files[0]);
	} else if (request?.files?.length) {
		description = `${request.files.length} files`;
	}

	if (errorMatch) meta.push(`${errorMatch[1]} errors`);
	if (warningMatch) meta.push(`${warningMatch[1]} warnings`);
	if (refMatch) {
		meta.push(formatCount("ref", Number.parseInt(refMatch[1], 10)));
		const fileSet = new Set(
			text
				.split("\n")
				.map(l => l.match(/^\s*(\S+):\d+:\d+/)?.[1])
				.filter(Boolean),
		);
		if (fileSet.size > 0) meta.push(formatCount("file", fileSet.size));
	}
	if (renameMatch) meta.push(`${renameMatch[1]} files`);
	if (request?.new_name && request?.query) meta.push(`${request.query} → ${request.new_name}`);

	return new Text(renderStatusLine({ icon: "success", title: `LSP ${action}`, description, meta }, theme), 0, 0);
}

// =============================================================================
// Hover Rendering
