import type { Component } from "../tui";
import { applyBackgroundToLine, padding } from "../utils";

/**
 * LeftBorderBox - a container that renders children with a colored left border accent
 * and an optional full-width background.
 *
 * Used as a lighter alternative to full-background Box for tool outputs.
 * The border character is colored via borderFn to indicate status.
 */
export class LeftBorderBox implements Component {
	children: Component[] = [];
	#borderFn: (char: string) => string;
	#bgFn?: (text: string) => string;
	#paddingLeft: number;
	#paddingY: number;

	constructor(paddingLeft = 1, paddingY = 0, borderFn?: (char: string) => string, bgFn?: (text: string) => string) {
		this.#paddingLeft = paddingLeft;
		this.#paddingY = paddingY;
		this.#borderFn = borderFn ?? (s => s);
		this.#bgFn = bgFn;
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

	setBgFn(bgFn?: (text: string) => string): void {
		this.#bgFn = bgFn;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) return [];

		const border = this.#borderFn("┃");
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
			result.push(this.#applyBg(border, width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.#applyBg(`${border}${leftPad}${line}`, width));
		}

		// Bottom padding
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(this.#applyBg(border, width));
		}

		return result;
	}

	#applyBg(line: string, width: number): string {
		if (!this.#bgFn) return line;
		return applyBackgroundToLine(line, width, this.#bgFn);
	}
}
