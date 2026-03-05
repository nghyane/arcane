import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { isEnoent, logger } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../tui";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../ui/render-utils";
import type { ToolSession } from ".";

const saveMemorySchema = Type.Object({
	fact: Type.String({ description: "A clear, self-contained statement to remember across sessions", minLength: 1 }),
});

type SaveMemoryParams = Static<typeof saveMemorySchema>;

export interface SaveMemoryToolDetails {
	fact: string;
	filePath: string;
	duplicate?: boolean;
}

interface SaveMemoryRenderArgs {
	fact?: string;
}

const MEMORIES_HEADING = "## Memories";
const MEMORIES_HEADING_RE = /^## Memories\s*$/;
const NEXT_HEADING_RE = /^## /;

async function findNearestAgentsMd(startDir: string): Promise<string | null> {
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;
	while (true) {
		const candidate = path.join(dir, "AGENTS.md");
		try {
			await Bun.file(candidate).text();
			return candidate;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const parent = path.dirname(dir);
		if (parent === dir || dir === root) break;
		dir = parent;
	}
	return null;
}

function insertMemory(content: string, fact: string): { content: string; duplicate: boolean } {
	const lines = content.split("\n");
	const bullet = `- ${fact}`;

	// Find Memories section
	let sectionStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (MEMORIES_HEADING_RE.test(lines[i])) {
			sectionStart = i;
			break;
		}
	}

	if (sectionStart === -1) {
		// Append section at end
		const trimmed = content.trimEnd();
		return { content: `${trimmed}\n\n${MEMORIES_HEADING}\n${bullet}\n`, duplicate: false };
	}

	// Find section end (next ## heading or EOF)
	let sectionEnd = lines.length;
	for (let i = sectionStart + 1; i < lines.length; i++) {
		if (NEXT_HEADING_RE.test(lines[i])) {
			sectionEnd = i;
			break;
		}
	}

	// Check duplicates among existing bullets
	const factLower = fact.toLowerCase();
	for (let i = sectionStart + 1; i < sectionEnd; i++) {
		const line = lines[i].trim();
		if (line.startsWith("- ")) {
			const existing = line.slice(2).toLowerCase();
			if (existing.includes(factLower) || factLower.includes(existing)) {
				return { content, duplicate: true };
			}
		}
	}

	// Insert bullet before sectionEnd
	lines.splice(sectionEnd, 0, bullet);
	return { content: lines.join("\n"), duplicate: false };
}

export class SaveMemoryTool implements AgentTool<typeof saveMemorySchema, SaveMemoryToolDetails, Theme> {
	readonly name = "save_memory";
	readonly label = "Save Memory";
	description =
		'Save a fact or preference to long-term memory that persists across sessions. Use when the user explicitly asks to remember something or states a clear preference. Facts should be short, self-contained: "Prefers tabs over spaces", "Project uses pnpm". Do not save transient conversation context. If unsure, ask the user.';
	readonly parameters = saveMemorySchema;
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: SaveMemoryParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SaveMemoryToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SaveMemoryToolDetails>> {
		const fact = params.fact.trim();
		if (!fact) {
			return {
				content: [{ type: "text", text: "Fact cannot be empty." }],
				details: { fact: "", filePath: "" },
			};
		}

		let filePath = await findNearestAgentsMd(this.session.cwd);
		let content: string;

		if (filePath) {
			content = await Bun.file(filePath).text();
		} else {
			filePath = path.join(this.session.cwd, "AGENTS.md");
			content = "";
		}

		const result = insertMemory(content, fact);

		if (result.duplicate) {
			return {
				content: [{ type: "text", text: "This fact is already saved." }],
				details: { fact, filePath, duplicate: true },
			};
		}

		try {
			await Bun.write(filePath, result.content);
		} catch (err) {
			logger.error("Failed to write AGENTS.md", { path: filePath, error: String(err) });
			return {
				content: [{ type: "text", text: "Failed to save memory." }],
				details: { fact, filePath },
			};
		}

		return {
			content: [{ type: "text", text: `Saved to ${filePath}` }],
			details: { fact, filePath },
		};
	}

	renderCall(args: SaveMemoryRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const preview = args.fact ? truncateToWidth(args.fact, TRUNCATE_LENGTHS.CONTENT) : "";
		const meta = preview ? [preview] : [];
		const text = renderStatusLine(
			{ icon: "running", spinnerFrame: options.spinnerFrame, title: "Save Memory", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SaveMemoryToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
		_args?: SaveMemoryRenderArgs,
	): Component {
		const details = result.details;
		const isDuplicate = details?.duplicate === true;
		const icon = isDuplicate ? "info" : "success";
		const filePath = details?.filePath ? shortenPath(details.filePath) : "";
		const meta = filePath ? [filePath] : [];
		const header = renderStatusLine({ icon, title: "Save Memory", meta }, uiTheme);

		const message = isDuplicate
			? uiTheme.fg("dim", "This fact is already saved.")
			: uiTheme.fg("dim", details?.fact ?? "");

		return new Text(`${header}\n${message}`, 0, 0);
	}
}
