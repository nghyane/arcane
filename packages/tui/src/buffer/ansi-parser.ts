import { Buffer } from "./buffer.js";
import { type Cell, DEFAULT_STYLE, emptyCell, Mod, NO_COLOR, packRgb, palette256ToRgb, type Style } from "./cell.js";

const STANDARD_COLORS: [number, number, number][] = [
	[0, 0, 0], // 0 black
	[187, 0, 0], // 1 red
	[0, 187, 0], // 2 green
	[187, 187, 0], // 3 yellow
	[0, 0, 187], // 4 blue
	[187, 0, 187], // 5 magenta
	[0, 187, 187], // 6 cyan
	[187, 187, 187], // 7 white
];

const BRIGHT_COLORS: [number, number, number][] = [
	[85, 85, 85], // 8
	[255, 85, 85], // 9
	[85, 255, 85], // 10
	[255, 255, 85], // 11
	[85, 85, 255], // 12
	[255, 85, 255], // 13
	[85, 255, 255], // 14
	[255, 255, 255], // 15
];

function standardColor(index: number): number {
	const [r, g, b] = STANDARD_COLORS[index]!;
	return packRgb(r, g, b);
}

function brightColor(index: number): number {
	const [r, g, b] = BRIGHT_COLORS[index]!;
	return packRgb(r, g, b);
}

const segmenter = new Intl.Segmenter();

function cloneStyle(s: Style): Style {
	return { fg: s.fg, bg: s.bg, mods: s.mods, link: s.link };
}

function parseSgr(params: number[], style: Style): void {
	let i = 0;
	while (i < params.length) {
		const p = params[i]!;
		switch (p) {
			case 0:
				style.fg = NO_COLOR;
				style.bg = NO_COLOR;
				style.mods = 0;
				style.link = "";
				break;
			case 1:
				style.mods |= Mod.Bold;
				break;
			case 2:
				style.mods |= Mod.Dim;
				break;
			case 3:
				style.mods |= Mod.Italic;
				break;
			case 4:
				style.mods |= Mod.Underline;
				break;
			case 5:
				style.mods |= Mod.Blink;
				break;
			case 7:
				style.mods |= Mod.Reverse;
				break;
			case 8:
				style.mods |= Mod.Hidden;
				break;
			case 9:
				style.mods |= Mod.Strikethrough;
				break;
			case 22:
				style.mods &= ~(Mod.Bold | Mod.Dim);
				break;
			case 23:
				style.mods &= ~Mod.Italic;
				break;
			case 24:
				style.mods &= ~Mod.Underline;
				break;
			case 25:
				style.mods &= ~Mod.Blink;
				break;
			case 27:
				style.mods &= ~Mod.Reverse;
				break;
			case 28:
				style.mods &= ~Mod.Hidden;
				break;
			case 29:
				style.mods &= ~Mod.Strikethrough;
				break;
			case 30:
			case 31:
			case 32:
			case 33:
			case 34:
			case 35:
			case 36:
			case 37:
				style.fg = standardColor(p - 30);
				break;
			case 38: {
				const mode = params[i + 1];
				if (mode === 5 && i + 2 < params.length) {
					const idx = params[i + 2]!;
					style.fg = palette256ToRgb(idx);
					i += 2;
				} else if (mode === 2 && i + 4 < params.length) {
					style.fg = packRgb(params[i + 2]!, params[i + 3]!, params[i + 4]!);
					i += 4;
				} else {
					i = params.length; // malformed, skip rest
				}
				break;
			}
			case 39:
				style.fg = NO_COLOR;
				break;
			case 40:
			case 41:
			case 42:
			case 43:
			case 44:
			case 45:
			case 46:
			case 47:
				style.bg = standardColor(p - 40);
				break;
			case 48: {
				const mode = params[i + 1];
				if (mode === 5 && i + 2 < params.length) {
					const idx = params[i + 2]!;
					style.bg = palette256ToRgb(idx);
					i += 2;
				} else if (mode === 2 && i + 4 < params.length) {
					style.bg = packRgb(params[i + 2]!, params[i + 3]!, params[i + 4]!);
					i += 4;
				} else {
					i = params.length;
				}
				break;
			}
			case 49:
				style.bg = NO_COLOR;
				break;
			case 90:
			case 91:
			case 92:
			case 93:
			case 94:
			case 95:
			case 96:
			case 97:
				style.fg = brightColor(p - 90);
				break;
			case 100:
			case 101:
			case 102:
			case 103:
			case 104:
			case 105:
			case 106:
			case 107:
				style.bg = brightColor(p - 100);
				break;
		}
		i++;
	}
}

export function parseAnsiLine(line: string, width: number, style?: Style): Cell[] {
	const cells: Cell[] = [];
	const cur: Style = style ? cloneStyle(style) : cloneStyle(DEFAULT_STYLE);
	let col = 0;
	let cachedStyle: Style | null = null;
	let i = 0;
	const len = line.length;

	// Pre-strip ANSI to get visible text, but we need to process inline
	// Process character by character
	while (i < len && col < width) {
		const ch = line.charCodeAt(i);

		// ESC sequence
		if (ch === 0x1b) {
			const next = line.charCodeAt(i + 1);
			// CSI: \x1b[
			if (next === 0x5b) {
				// '['
				i += 2;
				// Parse parameters
				const params: number[] = [];
				let num = -1;
				while (i < len) {
					const c = line.charCodeAt(i);
					if (c >= 0x30 && c <= 0x39) {
						// digit
						num = (num === -1 ? 0 : num) * 10 + (c - 0x30);
						i++;
					} else if (c === 0x3b) {
						// ';'
						params.push(num === -1 ? 0 : num);
						num = -1;
						i++;
					} else if (c >= 0x40 && c <= 0x7e) {
						// final byte
						params.push(num === -1 ? 0 : num);
						if (c === 0x6d) {
							// 'm' = SGR
							parseSgr(params, cur);
							cachedStyle = null;
						}
						i++;
						break;
					} else {
						// intermediate bytes (0x20-0x2f), skip
						i++;
					}
				}
				continue;
			}
			// OSC: \x1b]
			if (next === 0x5d) {
				// ']'
				i += 2;
				// Read until BEL (0x07) or ST (\x1b\\)
				let oscContent = "";
				while (i < len) {
					if (line.charCodeAt(i) === 0x07) {
						i++;
						break;
					}
					if (line.charCodeAt(i) === 0x1b && line.charCodeAt(i + 1) === 0x5c) {
						i += 2;
						break;
					}
					oscContent += line[i];
					i++;
				}
				// Check for OSC 8 hyperlink
				if (oscContent.startsWith("8;")) {
					const semiIdx = oscContent.indexOf(";", 2);
					if (semiIdx !== -1) {
						cur.link = oscContent.slice(semiIdx + 1);
						cachedStyle = null;
					}
				}
				continue;
			}
			// Other ESC sequences - skip until we find a letter or run out
			i += 2;
			while (i < len) {
				const c = line.charCodeAt(i);
				if (c >= 0x40 && c <= 0x7e) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}

		// Tab
		if (ch === 0x09) {
			const spaces = Math.min(3, width - col);
			for (let s = 0; s < spaces; s++) {
				if (!cachedStyle) cachedStyle = cloneStyle(cur);
				cells.push({ char: " ", width: 1, style: cachedStyle });
				col++;
			}
			i++;
			continue;
		}

		// Control characters
		if (ch < 0x20) {
			i++;
			continue;
		}

		// ASCII fast path: printable ASCII (0x20-0x7E) is always width 1, single char
		if (ch >= 0x20 && ch <= 0x7e) {
			if (col >= width) break;
			if (!cachedStyle) cachedStyle = cloneStyle(cur);
			cells.push({ char: line[i]!, width: 1, style: cachedStyle });
			col++;
			i++;
			continue;
		}

		// Non-ASCII: use segmenter for grapheme cluster detection
		const remaining = line.slice(i);
		const seg = segmenter.segment(remaining);
		const first = seg[Symbol.iterator]().next();
		if (first.done) {
			i++;
			continue;
		}

		const grapheme = first.value.segment;
		const charWidth = Bun.stringWidth(grapheme);

		if (charWidth === 0) {
			i += grapheme.length;
			continue;
		}

		if (col + charWidth > width) {
			break;
		}

		if (!cachedStyle) cachedStyle = cloneStyle(cur);
		cells.push({ char: grapheme, width: charWidth, style: cachedStyle });
		col++;

		if (charWidth === 2) {
			if (!cachedStyle) cachedStyle = cloneStyle(cur);
			cells.push({ char: "", width: 0, style: cachedStyle });
			col++;
		}

		i += grapheme.length;
	}

	// Pad to width
	while (cells.length < width) {
		cells.push(emptyCell());
	}

	return cells;
}

export function linesToBuffer(lines: string[], width: number, height: number): Buffer {
	const buf = new Buffer(width, height);
	const rowCount = Math.min(lines.length, height);
	for (let row = 0; row < rowCount; row++) {
		const cells = parseAnsiLine(lines[row]!, width);
		for (let col = 0; col < width; col++) {
			buf.set(col, row, cells[col]!);
		}
	}
	return buf;
}
