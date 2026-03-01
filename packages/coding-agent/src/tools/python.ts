import type * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { ImageContent } from "@nghyane/arcane-ai";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { getProjectDir } from "@nghyane/arcane-utils/dirs";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { executePython, type PythonExecutorOptions } from "../ipy/executor";
import type { PythonStatusEvent } from "../ipy/kernel";
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary } from "../session/streaming-output";
import type { Theme } from "../theme/theme";
import { renderCodeCell, renderStatusLine } from "../tui";
import { formatExpandHint, PREVIEW_LIMITS, replaceTabs } from "../ui/render-utils";
import type { ToolSession } from ".";
import { type OutputMeta, toolResult } from "./output-meta";
import { allocateOutputArtifact, createTailBuffer } from "./output-utils";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError } from "./tool-errors";

export const PYTHON_DEFAULT_PREVIEW_LINES = 10;

const pythonSchema = Type.Object({
	cells: Type.Array(
		Type.Object({
			code: Type.String({ description: "Python code to execute" }),
			title: Type.Optional(Type.String({ description: "Optional label for the cell" })),
		}),
		{ description: "Code cells to execute sequentially" },
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	reset: Type.Optional(Type.Boolean({ description: "Reset kernel state before execution" })),
});
type PythonToolParams = Static<typeof pythonSchema>;

type PythonToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PythonToolDetails | undefined;
};

type PythonProxyExecutor = (params: PythonToolParams, signal?: AbortSignal) => Promise<PythonToolResult>;

interface PythonCellResult {
	index: number;
	title?: string;
	code: string;
	output: string;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
	statusEvents?: PythonStatusEvent[];
}

export interface PythonToolDetails {
	cells?: PythonCellResult[];
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	/** Structured status events from prelude helpers */
	statusEvents?: PythonStatusEvent[];
	isError?: boolean;
	/** Structured output metadata for notices */
	meta?: OutputMeta;
}

export interface PythonToolOptions {
	proxyExecutor?: PythonProxyExecutor;
}

export class PythonTool implements AgentTool<typeof pythonSchema, any, Theme> {
	readonly name = "python";
	readonly label = "Python";
	description = "Execute Python code in a persistent kernel";
	readonly parameters = pythonSchema;
	readonly concurrency = "exclusive";

	readonly #proxyExecutor?: PythonProxyExecutor;

	constructor(
		private readonly session: ToolSession | null,
		options?: PythonToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof pythonSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<PythonToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Python tool requires a session when not using proxy executor");
		}

		const { cells, timeout: rawTimeout = 30, cwd, reset } = params;
		// Clamp to reasonable range: 1s - 600s (10 min)
		const timeoutSec = Math.max(1, Math.min(600, rawTimeout));
		const timeoutMs = timeoutSec * 1000;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};

		try {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}

			const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
			let cwdStat: fs.Stats;
			try {
				cwdStat = await Bun.file(commandCwd).stat();
			} catch {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			if (!cwdStat.isDirectory()) {
				throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
			}

			const tailBuffer = createTailBuffer(DEFAULT_MAX_BYTES * 2);
			const jsonOutputs: unknown[] = [];
			const images: ImageContent[] = [];
			const statusEvents: PythonStatusEvent[] = [];

			const cellResults: PythonCellResult[] = cells.map((cell, index) => ({
				index,
				title: cell.title,
				code: cell.code,
				output: "",
				status: "pending",
			}));
			const cellOutputs: string[] = [];

			const appendTail = (text: string) => {
				tailBuffer.append(text);
			};

			const buildUpdateDetails = (): PythonToolDetails => {
				const details: PythonToolDetails = {
					cells: cellResults.map(cell => ({
						...cell,
						statusEvents: cell.statusEvents ? [...cell.statusEvents] : undefined,
					})),
				};
				if (jsonOutputs.length > 0) {
					details.jsonOutputs = jsonOutputs;
				}
				if (images.length > 0) {
					details.images = images;
				}
				if (statusEvents.length > 0) {
					details.statusEvents = statusEvents;
				}
				return details;
			};

			const pushUpdate = () => {
				if (!onUpdate) return;
				const tailText = tailBuffer.text();
				onUpdate({
					content: [{ type: "text", text: tailText }],
					details: buildUpdateDetails(),
				});
			};

			const sessionFile = this.session.getSessionFile?.() ?? undefined;
			const artifactsDir = this.session.getArtifactsDir?.() ?? undefined;
			const { artifactPath, artifactId } = await allocateOutputArtifact(this.session, "python");
			outputSink = new OutputSink({
				artifactPath,
				artifactId,
				onChunk: chunk => {
					appendTail(chunk);
					pushUpdate();
				},
			});
			const sessionId = sessionFile ? `session:${sessionFile}:cwd:${commandCwd}` : `cwd:${commandCwd}`;
			const baseExecutorOptions: Omit<PythonExecutorOptions, "reset"> = {
				cwd: commandCwd,
				timeoutMs,
				signal: combinedSignal,
				sessionId,
				kernelMode: this.session.settings.get("python.kernelMode"),
				useSharedGateway: this.session.settings.get("python.sharedGateway"),
				sessionFile: sessionFile ?? undefined,
				artifactsDir: artifactsDir ?? undefined,
			};

			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i];
				const isFirstCell = i === 0;
				const cellResult = cellResults[i];
				cellResult.status = "running";
				cellResult.output = "";
				cellResult.statusEvents = undefined;
				cellResult.exitCode = undefined;
				cellResult.durationMs = undefined;
				pushUpdate();

				const executorOptions: PythonExecutorOptions = {
					...baseExecutorOptions,
					reset: isFirstCell ? reset : false,
					onChunk: async chunk => {
						await outputSink!.push(chunk);
					},
				};

				const startTime = Date.now();
				const result = await executePython(cell.code, executorOptions);
				const durationMs = Date.now() - startTime;

				const cellStatusEvents: PythonStatusEvent[] = [];
				for (const output of result.displayOutputs) {
					if (output.type === "json") {
						jsonOutputs.push(output.data);
					}
					if (output.type === "image") {
						images.push({ type: "image", data: output.data, mimeType: output.mimeType });
					}
					if (output.type === "status") {
						statusEvents.push(output.event);
						cellStatusEvents.push(output.event);
					}
				}

				const cellOutput = result.output.trim();
				cellResult.output = cellOutput;
				cellResult.exitCode = result.exitCode;
				cellResult.durationMs = durationMs;
				cellResult.statusEvents = cellStatusEvents.length > 0 ? cellStatusEvents : undefined;

				let combinedCellOutput = "";
				if (cells.length > 1) {
					const cellHeader = `[${i + 1}/${cells.length}]`;
					const cellTitle = cell.title ? ` ${cell.title}` : "";
					if (cellOutput) {
						combinedCellOutput = `${cellHeader}${cellTitle}\n${cellOutput}`;
					} else {
						combinedCellOutput = `${cellHeader}${cellTitle} (ok)`;
					}
					cellOutputs.push(combinedCellOutput);
				} else if (cellOutput) {
					combinedCellOutput = cellOutput;
					cellOutputs.push(combinedCellOutput);
				}

				if (combinedCellOutput) {
					const prefix = cellOutputs.length > 1 ? "\n\n" : "";
					appendTail(`${prefix}${combinedCellOutput}`);
				}

				if (result.cancelled) {
					cellResult.status = "error";
					pushUpdate();
					const errorMsg = result.output || "Command aborted";
					const combinedOutput = cellOutputs.join("\n\n");
					const outputText =
						cells.length > 1
							? `${combinedOutput}\n\nCell ${i + 1} aborted: ${errorMsg}`
							: combinedOutput || errorMsg;

					const rawSummary = (await finalizeOutput()) ?? {
						output: "",
						truncated: false,
						totalLines: 0,
						totalBytes: 0,
						outputLines: 0,
						outputBytes: 0,
					};
					const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
					const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
					const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
					const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
					const summaryForMeta: OutputSummary = {
						output: combinedOutput,
						truncated: rawSummary.truncated,
						totalLines: outputLines + missingLines,
						totalBytes: outputBytes + missingBytes,
						outputLines,
						outputBytes,
						artifactId: rawSummary.artifactId,
					};

					const details: PythonToolDetails = {
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						images: images.length > 0 ? images : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};

					return toolResult(details)
						.text(outputText)
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.done();
				}

				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					cellResult.status = "error";
					pushUpdate();
					const combinedOutput = cellOutputs.join("\n\n");
					const outputText =
						cells.length > 1
							? `${combinedOutput}\n\nCell ${i + 1} failed (exit code ${result.exitCode}). Earlier cells succeeded—their state persists. Fix only cell ${i + 1}.`
							: combinedOutput
								? `${combinedOutput}\n\nCommand exited with code ${result.exitCode}`
								: `Command exited with code ${result.exitCode}`;

					const rawSummary = (await finalizeOutput()) ?? {
						output: "",
						truncated: false,
						totalLines: 0,
						totalBytes: 0,
						outputLines: 0,
						outputBytes: 0,
					};
					const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
					const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
					const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
					const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
					const summaryForMeta: OutputSummary = {
						output: combinedOutput,
						truncated: rawSummary.truncated,
						totalLines: outputLines + missingLines,
						totalBytes: outputBytes + missingBytes,
						outputLines,
						outputBytes,
						artifactId: rawSummary.artifactId,
					};

					const details: PythonToolDetails = {
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						images: images.length > 0 ? images : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};

					return toolResult(details)
						.text(outputText)
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.done();
				}

				cellResult.status = "complete";
				pushUpdate();
			}

			const combinedOutput = cellOutputs.join("\n\n");
			const outputText =
				combinedOutput || (jsonOutputs.length > 0 || images.length > 0 ? "(no text output)" : "(no output)");
			const rawSummary = (await finalizeOutput()) ?? {
				output: "",
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			};
			const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
			const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
			const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
			const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
			const summaryForMeta: OutputSummary = {
				output: combinedOutput,
				truncated: rawSummary.truncated,
				totalLines: outputLines + missingLines,
				totalBytes: outputBytes + missingBytes,
				outputLines,
				outputBytes,
				artifactId: rawSummary.artifactId,
			};

			const details: PythonToolDetails = {
				cells: cellResults,
				jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
				images: images.length > 0 ? images : undefined,
				statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
			};

			const resultBuilder = toolResult(details)
				.text(outputText)
				.truncationFromSummary(summaryForMeta, { direction: "tail" });

			return resultBuilder.done();
		} finally {
			if (!outputDumped) {
				try {
					await finalizeOutput();
				} catch {}
			}
		}
	}

	buildRenderContext(info: {
		args: PythonToolParams;
		result?: { content: Array<{ type: string; text?: string }>; details?: PythonToolDetails };
		expanded: boolean;
		getTextOutput: () => string;
	}): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		if (info.result) {
			context.output = info.getTextOutput().trimEnd();
			context.expanded = info.expanded;
			context.previewLines = PYTHON_DEFAULT_PREVIEW_LINES;
			if (typeof info.args.timeout === "number" && Number.isFinite(info.args.timeout)) {
				context.timeout = Math.max(1, Math.min(600, info.args.timeout));
			}
		}
		return context;
	}

	renderCall(args: PythonRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const cells = args.cells ?? [];
		const cwd = getProjectDir();
		let displayWorkdir = args.cwd;

		if (displayWorkdir) {
			const resolvedCwd = path.resolve(cwd);
			const resolvedWorkdir = path.resolve(displayWorkdir);
			if (resolvedWorkdir === resolvedCwd) {
				displayWorkdir = undefined;
			} else {
				const relativePath = path.relative(resolvedCwd, resolvedWorkdir);
				const isWithinCwd =
					relativePath && !relativePath.startsWith("..") && !relativePath.startsWith(`..${path.sep}`);
				if (isWithinCwd) {
					displayWorkdir = relativePath;
				}
			}
		}

		const workdirLabel = displayWorkdir ? `cd ${displayWorkdir}` : undefined;
		if (cells.length === 0) {
			const prompt = uiTheme.fg("accent", ">>>");
			const prefix = workdirLabel ? `${uiTheme.fg("dim", `${workdirLabel} && `)}` : "";
			const text = uiTheme.fg("toolTitle", uiTheme.bold(`${prompt} ${prefix}…`));
			return new Text(text, 0, 0);
		}

		// Cache state - cells don't change, only width varies
		let cached: { width: number; result: string[] } | undefined;

		return {
			render: (width: number): string[] => {
				if (cached && cached.width === width) {
					return cached.result;
				}

				const lines: string[] = [];
				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const cellTitle = cell.title;
					const combinedTitle =
						cellTitle && workdirLabel ? `${workdirLabel} · ${cellTitle}` : (cellTitle ?? workdirLabel);
					const cellLines = renderCodeCell(
						{
							code: cell.code,
							language: "python",
							index: i,
							total: cells.length,
							title: combinedTitle,
							status: "pending",
							width,
							codeMaxLines: PYTHON_DEFAULT_PREVIEW_LINES,
							expanded: true,
						},
						uiTheme,
					);
					lines.push(...cellLines);
					if (i < cells.length - 1) {
						lines.push("");
					}
				}
				cached = { width, result: lines };
				return lines;
			},
			invalidate: () => {
				cached = undefined;
			},
		};
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: PythonToolDetails },
		options: RenderResultOptions & { renderContext?: PythonRenderContext },
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const output = (
			options.renderContext?.output ??
			result.content?.find(c => c.type === "text")?.text ??
			""
		).trimEnd();
		const outputLines = output ? output.split("\n") : [];
		const total = outputLines.length;
		const isError = details?.cells?.some(c => c.status === "error") ?? false;
		const truncation = details?.meta?.truncation;
		const expanded = options.renderContext?.expanded ?? options.expanded;

		// Build header
		const cellCount = details?.cells?.length ?? 0;
		const codePreview = details?.cells?.[0]?.code?.split("\n")[0]?.slice(0, 60) ?? "\u2026";
		const meta: string[] = [];
		if (cellCount > 1) meta.push(`${cellCount} cells`);
		if (total > 0) meta.push(`${total} lines`);
		if (details?.cells?.some(c => c.durationMs)) {
			const totalMs = details.cells.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
			if (totalMs > 0) meta.push(`${(totalMs / 1000).toFixed(1)}s`);
		}

		const header = renderStatusLine(
			{ icon: isError ? "error" : "success", title: "Python", description: `>>> ${codePreview}`, meta },
			uiTheme,
		);

		// Tree-style body
		const showAll = isError || expanded;
		const displayLines = showAll ? outputLines : outputLines.slice(-PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		const skipped = total - displayLines.length;

		const bodyLines: string[] = [];
		if (skipped > 0) {
			bodyLines.push(uiTheme.fg("dim", `\u2026 (${skipped} earlier lines)`));
		}
		const hasTruncation = Boolean(truncation);
		for (let i = 0; i < displayLines.length; i++) {
			bodyLines.push(uiTheme.fg("toolOutput", replaceTabs(displayLines[i])));
		}
		if (hasTruncation) {
			bodyLines.push(uiTheme.fg("warning", "output truncated"));
		}
		if (!showAll && skipped > 0) {
			bodyLines.push(formatExpandHint(uiTheme));
		}

		const lines = bodyLines.length > 0 ? [header, ...bodyLines] : [header];
		return new Text(lines.join("\n"), 0, 0);
	}
}

interface PythonRenderArgs {
	cells?: Array<{ code: string; title?: string }>;
	timeout?: number;
	cwd?: string;
}

interface PythonRenderContext {
	output?: string;
	expanded?: boolean;
	previewLines?: number;
	timeout?: number;
}
