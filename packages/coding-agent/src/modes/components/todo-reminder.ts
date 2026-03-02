import { Container, LeftBorderBox, Spacer, Text } from "@nghyane/arcane-tui";
import { theme } from "../../theme/theme";
import type { TodoItem } from "../../tools/todo-write";

/**
 * Component that renders a todo completion reminder notification.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	#box: LeftBorderBox;

	constructor(
		private readonly todos: TodoItem[],
		private readonly attempt: number,
		private readonly maxAttempts: number,
	) {
		super();

		this.addChild(new Spacer(1));

		this.#box = new LeftBorderBox(1, 1, s => theme.fg("warning", s));
		this.addChild(this.#box);

		this.#rebuild();
	}

	#rebuild(): void {
		this.#box.clear();

		const count = this.todos.length;
		const label = count === 1 ? "todo" : "todos";
		const header = `${theme.icon.warning} ${count} incomplete ${label} - reminder ${this.attempt}/${this.maxAttempts}`;

		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		const todoList = this.todos.map(t => `  ${theme.checkbox.unchecked} ${t.content}`).join("\n");
		this.#box.addChild(new Text(theme.italic(todoList), 0, 0));
	}
}
