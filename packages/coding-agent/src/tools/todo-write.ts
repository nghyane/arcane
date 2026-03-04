import path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import { StringEnum } from "@nghyane/arcane-ai";
import type { Component } from "@nghyane/arcane-tui";
import { Text } from "@nghyane/arcane-tui";
import { logger, Snowflake } from "@nghyane/arcane-utils";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { ToolSession } from "../sdk";
import type { Theme } from "../theme/theme";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "../ui/render-utils";

const todoWriteSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String({ description: "Existing todo ID to update (omit for new)" })),
			content: Type.String({ description: "Todo description" }),
			status: StringEnum(["pending", "in_progress", "completed"], { description: "Todo status" }),
		}),
	),
});

type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
}

interface TodoFile {
	updatedAt: number;
	todos: TodoItem[];
}

export interface TodoWriteToolDetails {
	todos: TodoItem[];
	updatedAt: number;
	storage: "session" | "memory";
}

const TODO_FILE_NAME = "todos.json";

type TodoWriteParams = Static<typeof todoWriteSchema>;

function normalizeTodoStatus(status?: string): TodoStatus {
	switch (status) {
		case "in_progress":
			return "in_progress";
		case "completed":
		case "done":
		case "complete":
			return "completed";
		default:
			return "pending";
	}
}

function normalizeTodos(items: Array<{ id?: string; content?: string; status?: string }>): TodoItem[] {
	return items.map(item => {
		if (!item.content) {
			throw new Error("Todo content is required.");
		}
		const content = item.content.trim();
		if (!content) {
			throw new Error("Todo content cannot be empty.");
		}
		return {
			id: item.id && item.id.trim().length > 0 ? item.id : Snowflake.next(),
			content,
			status: normalizeTodoStatus(item.status),
		};
	});
}

async function loadTodoFile(filePath: string): Promise<TodoFile | null> {
	try {
		const text = await Bun.file(filePath).text();
		const data = JSON.parse(text) as TodoFile;
		if (!data || !Array.isArray(data.todos)) return null;
		return data;
	} catch (error) {
		logger.warn("Failed to read todo file", { path: filePath, error: String(error) });
		return null;
	}
}

function formatTodoSummary(todos: TodoItem[]): string {
	if (todos.length === 0) return "Todo list cleared.";
	const completed = todos.filter(t => t.status === "completed").length;
	const inProgress = todos.filter(t => t.status === "in_progress").length;
	const pending = todos.filter(t => t.status === "pending").length;
	return `Saved ${todos.length} todos (${pending} pending, ${inProgress} in progress, ${completed} completed).`;
}

function formatTodoLine(item: TodoItem, uiTheme: Theme, prefix: string): string {
	const checkbox = uiTheme.checkbox;
	switch (item.status) {
		case "completed":
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(item.content)}`);
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${item.content}`);
		default:
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${item.content}`);
	}
}

// =============================================================================
// Tool Class
interface TodoWriteRenderArgs {
	todos?: Array<{ id?: string; content?: string; status?: string }>;
}

export class TodoWriteTool implements AgentTool<typeof todoWriteSchema, TodoWriteToolDetails, Theme> {
	readonly name = "todo_write";
	readonly label = "Todo Write";
	description = "Update the task/todo list";
	readonly parameters = todoWriteSchema;
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: TodoWriteParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoWriteToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoWriteToolDetails>> {
		const todos = normalizeTodos(params.todos ?? []);
		const updatedAt = Date.now();

		const sessionFile = this.session.getSessionFile();
		if (!sessionFile) {
			return {
				content: [{ type: "text", text: formatTodoSummary(todos) }],
				details: { todos, updatedAt, storage: "memory" },
			};
		}

		const todoPath = path.join(sessionFile.slice(0, -6), TODO_FILE_NAME);
		const existing = await loadTodoFile(todoPath);
		const storedTodos = existing?.todos ?? [];
		const merged = todos.length > 0 ? todos : [];
		const fileData: TodoFile = { updatedAt, todos: merged };

		try {
			await Bun.write(todoPath, JSON.stringify(fileData, null, 2));
		} catch (error) {
			logger.error("Failed to write todo file", { path: todoPath, error: String(error) });
			return {
				content: [{ type: "text", text: "Failed to save todos." }],
				details: { todos: storedTodos, updatedAt, storage: "session" },
			};
		}

		return {
			content: [{ type: "text", text: formatTodoSummary(merged) }],
			details: { todos: merged, updatedAt, storage: "session" },
		};
	}

	renderCall(args: TodoWriteRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const count = args.todos?.length ?? 0;
		const meta = count > 0 ? [`${count} items`] : ["empty"];
		const text = renderStatusLine(
			{ icon: "running", spinnerFrame: options.spinnerFrame, title: "Todo Write", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoWriteRenderArgs,
	): Component {
		const todos = result.details?.todos ?? [];
		const header = renderStatusLine(
			{ icon: "success", title: "Todo Write", meta: [`${todos.length} items`] },
			uiTheme,
		);
		if (todos.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text ?? "No todos";
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		const { expanded } = options;
		const treeLines = renderTreeList(
			{
				items: todos,
				expanded,
				maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
				itemType: "todo",
				renderItem: todo => formatTodoLine(todo, uiTheme, ""),
			},
			uiTheme,
		);
		const text = [header, ...treeLines].join("\n");
		return new Text(text, 0, 0);
	}
}
