/**
 * Undo edit tool — reverts the last edit/write to a file.
 */
import type { AgentTool, AgentToolResult } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { isEnoent, untilAborted } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { generateUnifiedDiffString } from "../patch/diff";
import { normalizeToLF, stripBom } from "../patch/normalize";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatErrorMessage, getDiffStats, shortenPath } from "../ui/render-utils";
import type { ToolSession } from ".";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";
import { popUndo } from "./undo-history";

const undoEditSchema = Type.Object({
	path: Type.String({ description: "File path to revert" }),
});

export interface UndoEditToolDetails {
	diff: string;
}

interface UndoEditRenderArgs {
	path?: string;
}

export class UndoEditTool implements AgentTool<typeof undoEditSchema, UndoEditToolDetails, Theme> {
	readonly name = "undo_edit";
	readonly label = "Undo";
	description = "Undo the last edit to a file";
	readonly parameters = undoEditSchema;
	readonly nonAbortable = true;
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		{ path }: Static<typeof undoEditSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<UndoEditToolDetails>> {
		return untilAborted(signal, async () => {
			const absolutePath = resolveToCwd(path, this.session.cwd);

			const previousContent = popUndo(absolutePath);
			if (previousContent === undefined) {
				throw new ToolError(`No undo history for ${path}. Only the most recent edit per file can be undone.`);
			}

			// Read current content for diff
			let currentContent = "";
			try {
				currentContent = await Bun.file(absolutePath).text();
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}

			await Bun.write(absolutePath, previousContent);
			invalidateFsScanAfterWrite(absolutePath);

			const normalizedOld = normalizeToLF(stripBom(currentContent).text);
			const normalizedNew = normalizeToLF(stripBom(previousContent).text);
			const diffResult = generateUnifiedDiffString(normalizedOld, normalizedNew);

			return {
				content: [{ type: "text", text: `Reverted ${path} to its state before the last edit` }],
				details: { diff: diffResult.diff },
			};
		});
	}

	renderCall(args: UndoEditRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const filePath = shortenPath(args.path ?? "");
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const text = renderStatusLine(
			{ icon: "running", spinnerFrame: options.spinnerFrame, title: "Undo", description: pathDisplay },
			uiTheme,
		);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: UndoEditToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: UndoEditRenderArgs,
	): Component {
		const filePath = shortenPath(args?.path ?? "");
		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}
		const meta: string[] = ["reverted"];
		if (result.details?.diff) {
			const diffStats = getDiffStats(result.details.diff);
			if (diffStats.added > 0) meta.push(`+${diffStats.added}`);
			if (diffStats.removed > 0) meta.push(`-${diffStats.removed}`);
		}
		return new Text(
			renderStatusLine({ icon: "success", title: "Undo", description: filePath || "file", meta }, uiTheme),
			0,
			0,
		);
	}
}
