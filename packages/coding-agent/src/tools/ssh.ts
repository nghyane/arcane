import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { SSHHost } from "../capability/ssh";
import { sshCapability } from "../capability/ssh";
import { loadCapability } from "../discovery";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { DEFAULT_MAX_BYTES } from "../session/streaming-output";
import type { SSHHostInfo } from "../ssh/connection-manager";
import { ensureHostInfo, getHostInfoForHost } from "../ssh/connection-manager";
import { executeSSH } from "../ssh/ssh-executor";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { formatClickHint, replaceTabs } from "../ui/render-utils";
import type { ToolSession } from ".";
import { type OutputMeta, toolResult } from "./output-meta";
import { allocateOutputArtifact, createTailBuffer } from "./output-utils";
import { ToolError } from "./tool-errors";

const sshSchema = Type.Object({
	host: Type.String({ description: "SSH host alias (from ~/.ssh/config)" }),
	command: Type.String({ description: "Shell command to execute on the remote host" }),
	cwd: Type.Optional(Type.String({ description: "Working directory on the remote host" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
});

export interface SSHToolDetails {
	meta?: OutputMeta;
}

async function formatHostEntry(host: SSHHost): Promise<string> {
	const info = await getHostInfoForHost(host);

	let shell: string;
	if (!info) {
		shell = "detecting...";
	} else if (info.os === "windows") {
		if (info.compatEnabled) {
			const compatShell = info.compatShell || "bash";
			shell = `windows/${compatShell}`;
		} else if (info.shell === "powershell") {
			shell = "windows/powershell";
		} else {
			shell = "windows/cmd";
		}
	} else if (info.os === "linux") {
		shell = `linux/${info.shell}`;
	} else if (info.os === "macos") {
		shell = `macos/${info.shell}`;
	} else {
		shell = `unknown/${info.shell}`;
	}

	return `- ${host.name} (${host.host}) | ${shell}`;
}

async function formatDescription(hosts: SSHHost[]): Promise<string> {
	if (hosts.length === 0) return "";
	const hostList = (await Promise.all(hosts.map(formatHostEntry))).join("\n");
	return `Available hosts:\n${hostList}`;
}

function quoteRemotePath(value: string): string {
	if (value.length === 0) {
		return "''";
	}
	const escaped = value.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

function quotePowerShellPath(value: string): string {
	if (value.length === 0) {
		return "''";
	}
	const escaped = value.replace(/'/g, "''");
	return `'${escaped}'`;
}

function quoteCmdPath(value: string): string {
	const escaped = value.replace(/"/g, '""');
	return `"${escaped}"`;
}

function buildRemoteCommand(command: string, cwd: string | undefined, info: SSHHostInfo): string {
	if (!cwd) return command;

	if (info.os === "windows" && !info.compatEnabled) {
		if (info.shell === "powershell") {
			return `Set-Location -Path ${quotePowerShellPath(cwd)}; ${command}`;
		}
		return `cd /d ${quoteCmdPath(cwd)} && ${command}`;
	}

	return `cd -- ${quoteRemotePath(cwd)} && ${command}`;
}

async function loadHosts(session: ToolSession): Promise<{
	hostNames: string[];
	hostsByName: Map<string, SSHHost>;
}> {
	const result = await loadCapability<SSHHost>(sshCapability.id, { cwd: session.cwd });
	const hostsByName = new Map<string, SSHHost>();
	for (const host of result.items) {
		if (!hostsByName.has(host.name)) {
			hostsByName.set(host.name, host);
		}
	}
	const hostNames = Array.from(hostsByName.keys()).sort();
	return { hostNames, hostsByName };
}

type SshToolParams = Static<typeof sshSchema>;

export class SshTool implements AgentTool<typeof sshSchema, SSHToolDetails, Theme> {
	readonly name = "ssh";
	readonly label = "SSH";
	readonly parameters = sshSchema;
	readonly concurrency = "exclusive";

	readonly #allowedHosts: Set<string>;

	constructor(
		private readonly session: ToolSession,
		private readonly hostNames: string[],
		private readonly hostsByName: Map<string, SSHHost>,
		readonly description: string,
	) {
		this.#allowedHosts = new Set(this.hostNames);
	}

	async execute(
		_toolCallId: string,
		{ host, command, cwd, timeout: rawTimeout = 60 }: SshToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SSHToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<SSHToolDetails>> {
		if (!this.#allowedHosts.has(host)) {
			throw new ToolError(`Unknown SSH host: ${host}. Available hosts: ${this.hostNames.join(", ")}`);
		}

		const hostConfig = this.hostsByName.get(host);
		if (!hostConfig) {
			throw new ToolError(`SSH host not loaded: ${host}`);
		}

		const hostInfo = await ensureHostInfo(hostConfig);
		const remoteCommand = buildRemoteCommand(command, cwd, hostInfo);

		// Clamp to reasonable range: 1s - 3600s (1 hour)
		const timeoutSec = Math.max(1, Math.min(3600, rawTimeout));
		const timeoutMs = timeoutSec * 1000;

		const tailBuffer = createTailBuffer(DEFAULT_MAX_BYTES);
		const { artifactPath, artifactId } = await allocateOutputArtifact(this.session, "ssh");

		const result = await executeSSH(hostConfig, remoteCommand, {
			timeout: timeoutMs,
			signal,
			compatEnabled: hostInfo.compatEnabled,
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

		if (result.cancelled) {
			throw new ToolError(result.output || "Command aborted");
		}

		const outputText = result.output || "(no output)";
		const details: SSHToolDetails = {};
		const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });

		if (result.exitCode !== 0 && result.exitCode !== undefined) {
			throw new ToolError(`${outputText}\n\nCommand exited with code ${result.exitCode}`);
		}

		return resultBuilder.done();
	}

	renderCall(args: SshRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const host = args.host || "…";
		const command = args.command || "…";
		const text = renderStatusLine({ icon: "pending", title: "SSH", description: `[${host}] $ ${command}` }, uiTheme);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SSHToolDetails },
		options: RenderResultOptions & { renderContext?: SshRenderContext },
		uiTheme: Theme,
		args?: SshRenderArgs,
	): Component {
		const host = args?.host || "…";
		const command = args?.command || "…";
		const cmdText = `[${host}] $ ${command}`;
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		const output = textContent.trimEnd();
		const outputLines = output ? output.split("\n") : [];
		const total = outputLines.length;
		const truncation = result.details?.meta?.truncation;
		const isError = false;

		const meta: string[] = [];
		if (total > 0) meta.push(`${total} lines`);

		const header = renderStatusLine(
			{ icon: isError ? "error" : "success", title: "SSH", description: cmdText, meta },
			uiTheme,
		);

		const TAIL = 4;
		const expanded = options.expanded;
		const showAll = isError || expanded;
		const displayLines = showAll ? outputLines : outputLines.slice(-TAIL);
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

		const lines = bodyLines.length > 0 ? [header, ...bodyLines] : [header];
		return new Text(lines.join("\n"), 0, 0);
	}
}

export async function loadSshTool(session: ToolSession): Promise<SshTool | null> {
	const { hostNames, hostsByName } = await loadHosts(session);
	if (hostNames.length === 0) {
		return null;
	}

	const descriptionHosts = hostNames
		.map(name => hostsByName.get(name))
		.filter((host): host is SSHHost => host !== undefined);
	const description = await formatDescription(descriptionHosts);

	return new SshTool(session, hostNames, hostsByName, description);
}

interface SshRenderArgs {
	host?: string;
	command?: string;
	timeout?: number;
}

interface SshRenderContext {}
