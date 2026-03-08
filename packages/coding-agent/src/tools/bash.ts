import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { $env, isEnoent } from "@nghyane/arcane-utils";
import { getProjectDir } from "@nghyane/arcane-utils/dirs";
import { type Static, Type } from "@sinclair/typebox";
import { type BashResult, executeBash } from "../exec/bash-executor";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { DEFAULT_MAX_BYTES } from "../session/streaming-output";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatClickHint, PREVIEW_LIMITS, replaceTabs } from "../ui/render-utils";
import type { ToolSession } from ".";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { applyHeadTail } from "./bash-normalize";
import { expandInternalUrls } from "./bash-skill-urls";
import { type OutputMeta, toolResult } from "./output-meta";
import { allocateOutputArtifact, createTailBuffer } from "./output-utils";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError } from "./tool-errors";

export const BASH_DEFAULT_PREVIEW_LINES = 10;

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	head: Type.Optional(Type.Number({ description: "Return only the first N lines of output" })),
	tail: Type.Optional(Type.Number({ description: "Return only the last N lines of output" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	meta?: OutputMeta;
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

export class BashTool implements AgentTool<typeof bashSchema, BashToolDetails, Theme> {
	readonly name = "bash";
	readonly label = "Bash";
	description =
		"Execute a shell command. Use grep/find instead of shell grep/find, read instead of cat/head/tail, edit instead of sed/awk, write instead of echo/printf redirects.";
	readonly parameters = bashSchema;
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		{ command: rawCommand, timeout: rawTimeout = 300, cwd, head, tail }: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		let command = rawCommand;

		const headLines = head;
		const tailLines = tail;

		if (this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const interception = checkBashInterception(command, ctx?.toolNames ?? [], rules);
			if (interception.block) {
				throw new ToolError(interception.message ?? "Command blocked");
			}
		}

		command = await expandInternalUrls(command, {
			skills: this.session.skills ?? [],
			internalRouter: this.session.internalRouter,
		});

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}

		const timeoutSec = Math.max(1, Math.min(3600, rawTimeout));
		const timeoutMs = timeoutSec * 1000;

		const tailBuffer = createTailBuffer(DEFAULT_MAX_BYTES);

		const artifactsDir = this.session.getArtifactsDir?.();
		const extraEnv = artifactsDir ? { ARTIFACTS: artifactsDir } : undefined;
		const { artifactPath, artifactId } = await allocateOutputArtifact(this.session, "bash");

		const usePty =
			this.session.settings.get("bash.virtualTerminal") === "on" &&
			$env.ARCANE_NO_PTY !== "1" &&
			ctx?.hasUI === true &&
			ctx.ui !== undefined;
		const result: BashResult | BashInteractiveResult = usePty
			? await runInteractiveBashPty(ctx.ui!, {
					command,
					cwd: commandCwd,
					timeoutMs,
					signal,
					env: extraEnv,
					artifactPath,
					artifactId,
				})
			: await executeBash(command, {
					cwd: commandCwd,
					sessionKey: this.session.getSessionId?.() ?? undefined,
					timeout: timeoutMs,
					signal,
					env: extraEnv,
					artifactPath,
					artifactId,
					onChunk: chunk => {
						tailBuffer.append(chunk);
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: tailBuffer.text() }],
								details: {},
							});
						}
					},
				});
		if (result.timedOut) {
			throw new ToolError(normalizeResultOutput(result) || `Command timed out after ${timeoutSec} seconds`);
		}
		if (result.cancelled) {
			if (signal?.aborted) {
				throw new ToolAbortError(normalizeResultOutput(result) || "Command aborted");
			}
			throw new ToolError(normalizeResultOutput(result) || "Command aborted");
		}
		let outputText = normalizeResultOutput(result);
		const headTailResult = applyHeadTail(outputText, headLines, tailLines);
		if (headTailResult.applied) {
			outputText = headTailResult.text;
		}
		if (!outputText) {
			outputText = "(no output)";
		}
		const details: BashToolDetails = {};
		const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status`);
		}
		if (result.exitCode !== 0) {
			throw new ToolError(`${outputText}\n\nCommand exited with code ${result.exitCode}`);
		}

		return resultBuilder.done();
	}

	buildRenderContext(info: {
		args: BashToolInput;
		result?: AgentToolResult<BashToolDetails>;
		expanded: boolean;
		getTextOutput: () => string;
	}): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		if (info.result) {
			context.output = info.getTextOutput().trimEnd();
			context.expanded = info.expanded;
			context.previewLines = BASH_DEFAULT_PREVIEW_LINES;
			if (typeof info.args.timeout === "number" && Number.isFinite(info.args.timeout)) {
				context.timeout = Math.max(1, Math.min(3600, info.args.timeout));
			}
		}
		return context;
	}

	renderCall(args: BashRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const cmdText = formatBashCommand(args, uiTheme);
		const text = renderStatusLine(
			{ icon: "running", spinnerFrame: options.spinnerFrame, title: "Bash", description: cmdText },
			uiTheme,
		);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: BashToolDetails;
			isError?: boolean;
		},
		options: RenderResultOptions & { renderContext?: BashRenderContext },
		uiTheme: Theme,
		args?: BashRenderArgs,
	): Component {
		const cmdText = args ? formatBashCommand(args, uiTheme) : "…";
		const isError = result.isError === true;
		const { renderContext } = options;
		const output = (renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "").trimEnd();
		const outputLines = output ? output.split("\n") : [];
		const total = outputLines.length;
		const truncation = result.details?.meta?.truncation;

		const meta: string[] = [];
		if (isError) meta.push("failed");
		if (total > 0) meta.push(`${total} lines`);

		const header = renderStatusLine(
			{ icon: isError ? "error" : "success", title: "Bash", description: cmdText, meta },
			uiTheme,
		);

		const expanded = renderContext?.expanded ?? options.expanded;
		const showAll = isError || expanded;
		const displayLines = showAll ? outputLines : outputLines.slice(-PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		const skipped = total - displayLines.length;

		const bodyLines: string[] = [];
		if (skipped > 0) {
			bodyLines.push(uiTheme.fg("dim", `… (${skipped} earlier lines)`));
		}
		const hasTruncation = Boolean(truncation);
		for (let i = 0; i < displayLines.length; i++) {
			bodyLines.push(uiTheme.fg("toolOutput", replaceTabs(displayLines[i])));
		}

		if (hasTruncation) {
			bodyLines.push(uiTheme.fg("warning", "output truncated"));
		}
		if (!showAll && skipped > 0) {
			bodyLines.push(formatClickHint(uiTheme));
		}

		const lines = bodyLines.length > 0 ? [header, ...bodyLines] : [header];
		return new Text(lines.join("\n"), 0, 0);
	}
}

interface BashRenderArgs {
	command?: string;
	timeout?: number;
	cwd?: string;
}

interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

function formatBashCommand(args: BashRenderArgs, _uiTheme: Theme): string {
	const command = args.command || "…";
	const prompt = "$";
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

	return displayWorkdir ? `${prompt} cd ${displayWorkdir} && ${command}` : `${prompt} ${command}`;
}
