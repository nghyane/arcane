import type { Component } from "../tui";
import { padding } from "../utils";

/**
 * LeftBorderBox - a container that renders children with a colored left border accent.
 *
 * Used as a lighter alternative to full-background Box for tool outputs.
 * The border character is colored via borderFn to indicate status.
 */
export class LeftBorderBox implements Component {
	children: Component[] = [];
	#borderFn: (char: string) => string;
	#paddingLeft: number;
	#paddingY: number;

	constructor(paddingLeft = 1, paddingY = 0, borderFn?: (char: string) => string) {
		this.#paddingLeft = paddingLeft;
		this.#paddingY = paddingY;
		this.#borderFn = borderFn ?? (s => s);
	}

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	setBorderFn(borderFn: (char: string) => string): void {
		this.#borderFn = borderFn;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) return [];

		const border = this.#borderFn("│");
		const leftPad = padding(this.#paddingLeft);
		// Border char takes 1 visible column + paddingLeft
		const contentWidth = Math.max(1, width - 1 - this.#paddingLeft);

		const childLines: string[] = [];
		for (const child of this.children) {
			childLines.push(...child.render(contentWidth));
		}

		if (childLines.length === 0) return [];

		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(border);
		}

		// Content
		for (const line of childLines) {
			result.push(`${border}${leftPad}${line}`);
		}

		// Bottom padding
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(border);
		}

		return result;
	}
}
