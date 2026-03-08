import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { type AsciiRenderOptions, renderMermaidAscii } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../ui/render-utils";
import type { ToolSession } from "./index";
import { allocateOutputArtifact } from "./output-utils";

const renderMermaidSchema = Type.Object({
	mermaid: Type.String({ description: "Mermaid graph source text" }),
	config: Type.Optional(
		Type.Object({
			useAscii: Type.Optional(Type.Boolean()),
			paddingX: Type.Optional(Type.Number()),
			paddingY: Type.Optional(Type.Number()),
			boxBorderPadding: Type.Optional(Type.Number()),
		}),
	),
});

type RenderMermaidParams = Static<typeof renderMermaidSchema>;

function sanitizeRenderConfig(config: AsciiRenderOptions | undefined): AsciiRenderOptions | undefined {
	if (!config) return undefined;
	return {
		useAscii: config.useAscii,
		boxBorderPadding:
			config.boxBorderPadding === undefined ? undefined : Math.max(0, Math.floor(config.boxBorderPadding)),
		paddingX: config.paddingX === undefined ? undefined : Math.max(0, Math.floor(config.paddingX)),
		paddingY: config.paddingY === undefined ? undefined : Math.max(0, Math.floor(config.paddingY)),
	};
}

export interface RenderMermaidToolDetails {
	ascii?: string;
	artifactId?: string;
}

export class RenderMermaidTool implements AgentTool<typeof renderMermaidSchema, RenderMermaidToolDetails, Theme> {
	readonly name = "render_mermaid";
	readonly label = "RenderMermaid";
	readonly description =
		"Convert Mermaid graph source into ASCII diagram output. Returns ASCII diagram text. Saves full output to an artifact URL when artifact storage is available. The diagram is displayed directly in the output — do not reproduce it.";
	readonly parameters = renderMermaidSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}
	async execute(
		_toolCallId: string,
		params: RenderMermaidParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RenderMermaidToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RenderMermaidToolDetails>> {
		const ascii = renderMermaidAscii(params.mermaid, sanitizeRenderConfig(params.config));
		const { artifactPath, artifactId } = await allocateOutputArtifact(this.session, "render_mermaid");
		if (artifactPath) {
			await Bun.write(artifactPath, ascii);
		}

		return {
			content: [
				{ type: "text", text: artifactId ? `Saved artifact: artifact://${artifactId}` : "Diagram rendered." },
			],
			details: { ascii, artifactId },
		};
	}

	renderCall(_args: RenderMermaidParams, options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine(
			{
				icon: "running",
				spinnerFrame: options.spinnerFrame,
				title: "RenderMermaid",
				description: "Rendering diagram…",
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: RenderMermaidToolDetails;
			isError?: boolean;
		},
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: RenderMermaidParams,
	): Component {
		const icon = result.isError ? "error" : "success";
		const ascii = result.details?.ascii ?? "";
		const outputLines = ascii ? ascii.split("\n") : [];
		const lines: string[] = [];

		const meta: string[] = [];
		if (outputLines.length > 0) meta.push(`${outputLines.length} lines`);
		if (result.details?.artifactId) meta.push(`artifact://${result.details.artifactId}`);

		lines.push(renderStatusLine({ icon, title: "RenderMermaid", meta }, uiTheme));

		if (outputLines.length > 0) {
			const maxLines = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
			const displayLines = outputLines.slice(0, maxLines);
			for (const line of displayLines) {
				lines.push(uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.CONTENT)));
			}
			if (outputLines.length > maxLines) {
				lines.push(uiTheme.fg("dim", `… (${outputLines.length - maxLines} more lines)`));
			}
		}

		return new Text(lines.join("\n"), 0, 0);
	}
}
