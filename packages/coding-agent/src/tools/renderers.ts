/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 * All tools — including subagent tools — render through this single registry.
 */
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { editToolRenderer } from "../patch";
import { renderResult as renderTaskResult, taskToolRenderer } from "../task/render";
import { renderStatusLine } from "../tui";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { bashToolRenderer } from "./bash";
import { calculatorToolRenderer } from "./calculator";
import { exploreConfig } from "./explore";
import { fetchToolRenderer } from "./fetch";
import { findToolRenderer } from "./find";
import { grepToolRenderer } from "./grep";
import { librarianConfig } from "./librarian";
import { notebookToolRenderer } from "./notebook";
import { oracleConfig } from "./oracle";
import { pythonToolRenderer } from "./python";
import { readToolRenderer } from "./read";
import { replaceTabs, truncateToWidth } from "./render-utils";
import { reviewerConfig } from "./reviewer-tool";
import { sshToolRenderer } from "./ssh";
import type { SubagentConfig } from "./subagent-tool";
import { todoWriteToolRenderer } from "./todo-write";
import { undoEditToolRenderer } from "./undo-edit";
import { writeToolRenderer } from "./write";

type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
};

function createSubagentRenderer(config: SubagentConfig): ToolRenderer {
	return {
		renderCall(args: unknown, _options: RenderResultOptions, theme: Theme): Component {
			const params = args as Record<string, unknown>;
			const desc = truncateToWidth(replaceTabs(config.buildDescription(params)), 80);
			return new Text(renderStatusLine({ icon: "pending", title: config.label, description: desc }, theme), 0, 0);
		},
		renderResult: renderTaskResult as ToolRenderer["renderResult"],
		mergeCallAndResult: true,
	};
}

const subagentConfigs: SubagentConfig[] = [exploreConfig, librarianConfig, oracleConfig, reviewerConfig];

const subagentRenderers: Record<string, ToolRenderer> = Object.fromEntries(
	subagentConfigs.map(c => [c.name, createSubagentRenderer(c)]),
);

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	python: pythonToolRenderer as ToolRenderer,
	calc: calculatorToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	find: findToolRenderer as ToolRenderer,
	grep: grepToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	notebook: notebookToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	task: taskToolRenderer as ToolRenderer,
	todo_write: todoWriteToolRenderer as ToolRenderer,
	undo_edit: undoEditToolRenderer as ToolRenderer,
	fetch: fetchToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
	...subagentRenderers,
};
