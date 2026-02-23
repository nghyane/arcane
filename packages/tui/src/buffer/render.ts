import type { Buffer, CellChange } from "./buffer.js";
import { DEFAULT_STYLE, hasColor, Mod, type Style, unpackRgb } from "./cell.js";

function styleEquals(a: Style, b: Style): boolean {
	return a.fg === b.fg && a.bg === b.bg && a.mods === b.mods && a.link === b.link;
}

function emitStyleDiff(prev: Style, next: Style, parts: string[], defaultBg = 0): void {
	// Check if reset is simpler
	const needReset =
		(prev.mods & ~next.mods) !== 0 ||
		(hasColor(prev.fg) && !hasColor(next.fg)) ||
		(hasColor(prev.bg) && !hasColor(next.bg));

	if (needReset) {
		parts.push("\x1b[0m");
		// After reset, emit everything in next that isn't default
		if (next.mods) emitMods(0, next.mods, parts);
		if (hasColor(next.fg)) {
			const [r, g, b] = unpackRgb(next.fg);
			parts.push(`\x1b[38;2;${r};${g};${b}m`);
		}
		if (hasColor(next.bg)) {
			const [r, g, b] = unpackRgb(next.bg);
			parts.push(`\x1b[48;2;${r};${g};${b}m`);
		} else if (defaultBg) {
			const [r, g, b] = unpackRgb(defaultBg);
			parts.push(`\x1b[48;2;${r};${g};${b}m`);
		}
	} else {
		if (prev.fg !== next.fg) {
			if (hasColor(next.fg)) {
				const [r, g, b] = unpackRgb(next.fg);
				parts.push(`\x1b[38;2;${r};${g};${b}m`);
			} else {
				parts.push("\x1b[39m");
			}
		}
		if (prev.bg !== next.bg) {
			if (hasColor(next.bg)) {
				const [r, g, b] = unpackRgb(next.bg);
				parts.push(`\x1b[48;2;${r};${g};${b}m`);
			} else {
				if (defaultBg) {
					const [r, g, b] = unpackRgb(defaultBg);
					parts.push(`\x1b[48;2;${r};${g};${b}m`);
				} else {
					parts.push("\x1b[49m");
				}
			}
		}
		if (prev.mods !== next.mods) {
			emitMods(prev.mods, next.mods, parts);
		}
	}

	if (prev.link !== next.link) {
		if (next.link) {
			parts.push(`\x1b]8;;${next.link}\x07`);
		} else {
			parts.push("\x1b]8;;\x07");
		}
	}
}

function emitMods(prev: number, next: number, parts: string[]): void {
	const added = next & ~prev;
	const removed = prev & ~next;

	if (added & Mod.Bold) parts.push("\x1b[1m");
	if (added & Mod.Dim) parts.push("\x1b[2m");
	if (added & Mod.Italic) parts.push("\x1b[3m");
	if (added & Mod.Underline) parts.push("\x1b[4m");
	if (added & Mod.Blink) parts.push("\x1b[5m");
	if (added & Mod.Reverse) parts.push("\x1b[7m");
	if (added & Mod.Hidden) parts.push("\x1b[8m");
	if (added & Mod.Strikethrough) parts.push("\x1b[9m");

	if (removed & Mod.Bold) parts.push("\x1b[22m");
	if (removed & Mod.Dim) parts.push("\x1b[22m");
	if (removed & Mod.Italic) parts.push("\x1b[23m");
	if (removed & Mod.Underline) parts.push("\x1b[24m");
	if (removed & Mod.Blink) parts.push("\x1b[25m");
	if (removed & Mod.Reverse) parts.push("\x1b[27m");
	if (removed & Mod.Hidden) parts.push("\x1b[28m");
	if (removed & Mod.Strikethrough) parts.push("\x1b[29m");
}

export function renderDiff(changes: CellChange[], _width: number, defaultBg = 0): string {
	if (changes.length === 0) return "";

	const sorted = [...changes].sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));

	const parts: string[] = [];
	let curRow = -1;
	let curCol = -1;
	let curStyle: Style = { ...DEFAULT_STYLE };

	for (const change of sorted) {
		const { col, row, cell } = change;

		// Skip placeholder cells
		if (cell.width === 0) continue;

		// Cursor positioning
		if (row !== curRow || col !== curCol) {
			// 1-based positioning
			parts.push(`\x1b[${row + 1};${col + 1}H`);
			curRow = row;
			curCol = col;
		}

		// Style changes
		if (!styleEquals(curStyle, cell.style)) {
			emitStyleDiff(curStyle, cell.style, parts, defaultBg);
			curStyle = { ...cell.style };
		}

		parts.push(cell.char);
		curCol += cell.width;
	}

	parts.push("\x1b[0m");
	if (defaultBg) {
		const [r, g, b] = unpackRgb(defaultBg);
		parts.push(`\x1b[48;2;${r};${g};${b}m`);
	}
	return parts.join("");
}

export function renderBuffer(buf: Buffer, defaultBg = 0): string[] {
	const lines: string[] = [];

	for (let row = 0; row < buf.height; row++) {
		const parts: string[] = [];
		let curStyle: Style = { ...DEFAULT_STYLE };

		for (let col = 0; col < buf.width; col++) {
			const cell = buf.get(col, row);

			// Skip placeholders
			if (cell.width === 0) continue;

			if (!styleEquals(curStyle, cell.style)) {
				emitStyleDiff(curStyle, cell.style, parts, defaultBg);
				curStyle = { ...cell.style };
			}

			parts.push(cell.char);
		}

		// Reset at end of line
		if (!styleEquals(curStyle, DEFAULT_STYLE)) {
			parts.push("\x1b[0m");
			if (defaultBg) {
				const [r, g, b] = unpackRgb(defaultBg);
				parts.push(`\x1b[48;2;${r};${g};${b}m`);
			}
		}

		lines.push(parts.join(""));
	}

	return lines;
}
