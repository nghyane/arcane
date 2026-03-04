import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import { type AsciiRenderOptions, renderMermaidAscii } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
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
	artifactId?: string;
}

export class RenderMermaidTool implements AgentTool<typeof renderMermaidSchema, RenderMermaidToolDetails> {
	readonly name = "render_mermaid";
	readonly label = "RenderMermaid";
	readonly description =
		"Convert Mermaid graph source into ASCII diagram output. Returns ASCII diagram text. Saves full output to an artifact URL when artifact storage is available.";
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

		const artifactLine = artifactId ? `\n\nSaved artifact: artifact://${artifactId}` : "";
		return {
			content: [{ type: "text", text: `${ascii}${artifactLine}` }],
			details: { artifactId },
		};
	}
}
