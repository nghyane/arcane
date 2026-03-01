import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import { type GrepResult, grep } from "@nghyane/arcane-natives";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { untilAborted } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { computeLineHash } from "../patch/hashline";
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateHead } from "../session/streaming-output";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatCount, formatEmptyMessage, formatErrorMessage } from "../ui/render-utils";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { type OutputMeta, toolResult } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Regex pattern to search for" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: cwd)" })),
	glob: Type.Optional(Type.String({ description: 'Glob filter for file paths (e.g. "*.ts")' })),
	type: Type.Optional(Type.String({ description: 'File extension filter without dot (e.g. "ts")' })),
	i: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	pre: Type.Optional(Type.Number({ description: "Context lines before match" })),
	post: Type.Optional(Type.Number({ description: "Context lines after match" })),
	multiline: Type.Optional(Type.Boolean({ description: "Enable multiline regex matching" })),
	limit: Type.Optional(Type.Number({ description: "Max number of matches to return" })),
	offset: Type.Optional(Type.Number({ description: "Skip first N matches" })),
});

export type GrepToolInput = Static<typeof grepSchema>;

const DEFAULT_MATCH_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	resultLimitReached?: number;
	linesTruncated?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
}

type GrepParams = Static<typeof grepSchema>;

export class GrepTool implements AgentTool<typeof grepSchema, GrepToolDetails, Theme> {
	readonly name = "grep";
	readonly label = "Grep";
	description = "Search file contents with regex";
	readonly parameters = grepSchema;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: GrepParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GrepToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<GrepToolDetails>> {
		const { pattern, path: searchDir, glob, type, i, pre, post, multiline, limit, offset } = params;

		return untilAborted(signal, async () => {
			const normalizedPattern = pattern.trim();
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const normalizedOffset = offset === undefined ? 0 : Number.isFinite(offset) ? Math.floor(offset) : Number.NaN;
			if (normalizedOffset < 0 || !Number.isFinite(normalizedOffset)) {
				throw new ToolError("Offset must be a non-negative number");
			}

			const rawLimit = limit === undefined ? undefined : Number.isFinite(limit) ? Math.floor(limit) : Number.NaN;
			if (rawLimit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 0)) {
				throw new ToolError("Limit must be a non-negative number");
			}
			const normalizedLimit = rawLimit !== undefined && rawLimit > 0 ? rawLimit : undefined;

			const defaultContextBefore = this.session.settings.get("grep.contextBefore");
			const defaultContextAfter = this.session.settings.get("grep.contextAfter");
			const normalizedContextBefore = pre ?? defaultContextBefore;
			const normalizedContextAfter = post ?? defaultContextAfter;
			const ignoreCase = i ?? false;
			const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
			const effectiveMultiline = multiline ?? patternHasNewline;

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			let searchPath: string;
			const internalRouter = this.session.internalRouter;
			if (searchDir && internalRouter?.canHandle(searchDir)) {
				const resource = await internalRouter.resolve(searchDir);
				if (!resource.sourcePath) {
					throw new ToolError(`Cannot grep internal URL without a backing file: ${searchDir}`);
				}
				searchPath = resource.sourcePath;
			} else {
				searchPath = resolveToCwd(searchDir || ".", this.session.cwd);
			}
			const scopePath = (() => {
				const relative = path.relative(this.session.cwd, searchPath).replace(/\\/g, "/");
				return relative.length === 0 ? "." : relative;
			})();

			let isDirectory: boolean;
			try {
				const stat = await Bun.file(searchPath).stat();
				isDirectory = stat.isDirectory();
			} catch {
				throw new ToolError(`Path not found: ${searchPath}`);
			}

			const effectiveOutputMode = "content";
			const effectiveLimit = normalizedLimit ?? DEFAULT_MATCH_LIMIT;

			// Run grep
			let result: GrepResult;
			try {
				result = await grep({
					pattern: normalizedPattern,
					path: searchPath,
					glob: glob?.trim() || undefined,
					type: type?.trim() || undefined,
					ignoreCase,
					multiline: effectiveMultiline,
					hidden: true,
					cache: false,
					maxCount: effectiveLimit,
					offset: normalizedOffset > 0 ? normalizedOffset : undefined,
					contextBefore: normalizedContextBefore,
					contextAfter: normalizedContextAfter,
					maxColumns: DEFAULT_MAX_COLUMN,
					mode: effectiveOutputMode,
				});
			} catch (err) {
				if (err instanceof Error && err.message.startsWith("regex parse error")) {
					throw new ToolError(err.message);
				}
				throw err;
			}

			const formatPath = (filePath: string): string => {
				// returns paths starting with / (the virtual root)
				const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
				if (isDirectory) {
					return cleanPath.replace(/\\/g, "/");
				}
				return path.basename(cleanPath);
			};

			// Build output
			const files = new Set<string>();
			const fileList: string[] = [];
			const fileMatchCounts = new Map<string, number>();

			const recordFile = (filePath: string) => {
				const relative = formatPath(filePath);
				if (!files.has(relative)) {
					files.add(relative);
					fileList.push(relative);
				}
			};

			if (result.totalMatches === 0) {
				const details: GrepToolDetails = {
					scopePath,
					matchCount: 0,
					fileCount: 0,
					files: [],
					truncated: false,
				};
				return toolResult(details).text("No matches found").done();
			}

			const outputLines: string[] = [];
			let linesTruncated = false;
			let matchIndex = 0;

			for (const match of result.matches) {
				recordFile(match.path);
				const relativePath = formatPath(match.path);

				matchIndex += 1;
				if (matchIndex > 1) {
					outputLines.push("");
				}
				outputLines.push(`${matchIndex}. ${relativePath}:${match.lineNumber}`);

				const lineNumbers: number[] = [match.lineNumber];
				if (match.contextBefore) {
					for (const ctx of match.contextBefore) {
						lineNumbers.push(ctx.lineNumber);
					}
				}
				if (match.contextAfter) {
					for (const ctx of match.contextAfter) {
						lineNumbers.push(ctx.lineNumber);
					}
				}
				const lineWidth = Math.max(...lineNumbers.map(value => value.toString().length));

				const formatLine = (lineNumber: number, line: string, isMatch: boolean): string => {
					if (useHashLines) {
						const ref = `${lineNumber}#${computeLineHash(lineNumber, line)}`;
						return isMatch ? `>>${ref}:${line}` : `  ${ref}:${line}`;
					}
					const padded = lineNumber.toString().padStart(lineWidth, " ");
					return isMatch ? `>>${padded}:${line}` : `  ${padded}:${line}`;
				};

				// Add context before
				if (match.contextBefore) {
					for (const ctx of match.contextBefore) {
						outputLines.push(formatLine(ctx.lineNumber, ctx.line, false));
					}
				}

				// Add match line
				outputLines.push(formatLine(match.lineNumber, match.line, true));

				if (match.truncated) {
					linesTruncated = true;
				}

				// Add context after
				if (match.contextAfter) {
					for (const ctx of match.contextAfter) {
						outputLines.push(formatLine(ctx.lineNumber, ctx.line, false));
					}
				}

				// Track per-file counts
				fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
			}

			const rawOutput = outputLines.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			const output = truncation.content;

			const truncated = Boolean(result.limitReached || truncation.truncated || linesTruncated);
			const details: GrepToolDetails = {
				scopePath,
				matchCount: result.totalMatches,
				fileCount: result.filesWithMatches,
				files: fileList,
				fileMatches: fileList.map(path => ({
					path,
					count: fileMatchCounts.get(path) ?? 0,
				})),
				truncated,
				matchLimitReached: result.limitReached ? effectiveLimit : undefined,
			};

			if (truncation.truncated) details.truncation = truncation;
			if (linesTruncated) details.linesTruncated = true;

			const resultBuilder = toolResult(details)
				.text(output)
				.limits({
					matchLimit: result.limitReached ? effectiveLimit : undefined,
					columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined,
				});

			if (truncation.truncated) {
				resultBuilder.truncation(truncation, { direction: "head" });
			}

			return resultBuilder.done();
		});
	}

	renderCall(args: GrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		if (args.glob) meta.push(`glob:${args.glob}`);
		if (args.type) meta.push(`type:${args.type}`);
		if (args.i) meta.push("case:insensitive");
		if (args.pre !== undefined && args.pre > 0) {
			meta.push(`pre:${args.pre}`);
		}
		if (args.post !== undefined && args.post > 0) {
			meta.push(`post:${args.post}`);
		}
		if (args.multiline) meta.push("multiline");
		if (args.limit !== undefined && args.limit > 0) meta.push(`limit:${args.limit}`);
		if (args.offset !== undefined && args.offset > 0) meta.push(`offset:${args.offset}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Grep", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncated = Boolean(
			details?.truncated ||
				details?.meta?.truncation ||
				details?.meta?.limits?.matchLimit ||
				details?.meta?.limits?.resultLimit ||
				details?.meta?.limits?.columnTruncated,
		);

		if (matchCount === 0) {
			return new Text(formatEmptyMessage("No matches found", uiTheme), 0, 0);
		}

		const meta = [formatCount("match", matchCount), formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));

		const text = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Grep", description: args?.pattern, meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	}
}

interface GrepRenderArgs {
	pattern: string;
	path?: string;
	glob?: string;
	type?: string;
	i?: boolean;
	pre?: number;
	post?: number;
	multiline?: boolean;
	limit?: number;
	offset?: number;
}
