/**
 * Undo edit tool — reverts the last edit/write to a file.
 */
import type { AgentTool, AgentToolResult } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { isEnoent, untilAborted } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { generateUnifiedDiffString } from "../patch/diff";
import { normalizeToLF, stripBom } from "../patch/normalize";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { resolveToCwd } from "./path-utils";
import { getDiffStats, replaceTabs, shortenPath, ToolUIKit } from "./render-utils";
import { ToolError } from "./tool-errors";
import { popUndo } from "./undo-history";

const undoEditSchema = Type.Object({
	path: Type.String({ description: "Path to the file whose last edit should be undone (relative or absolute)" }),
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
	readonly mergeCallAndResult = true;

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

	renderCall(args: UndoEditRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const filePath = shortenPath(args.path ?? "");
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const text = renderStatusLine({ icon: "pending", title: "Undo", description: pathDisplay }, uiTheme);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: UndoEditToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: UndoEditRenderArgs,
	): Component {
		const ui = new ToolUIKit(uiTheme);
		const filePath = shortenPath(args?.path ?? "");
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const errorText = result.isError ? (result.content?.find(c => c.type === "text")?.text ?? "") : "";

		let cached: RenderCache | undefined;

		return {
			render(width) {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;

				const header = renderStatusLine(
					{ icon: result.isError ? "error" : "success", title: "Undo", description: pathDisplay },
					uiTheme,
				);
				let text = header;

				if (result.isError) {
					if (errorText) {
						text += `\n\n${uiTheme.fg("error", replaceTabs(errorText))}`;
					}
				} else if (result.details?.diff) {
					const diffStats = getDiffStats(result.details.diff);
					text += `\n${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${ui.formatDiffStats(
						diffStats.added,
						diffStats.removed,
						diffStats.hunks,
					)}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;
				}

				const lines =
					width > 0 ? text.split("\n").map(line => truncateToWidth(line, width, Ellipsis.Omit)) : text.split("\n");
				cached = { key, lines };
				return lines;
			},
			invalidate() {
				cached = undefined;
			},
		};
	}
}
