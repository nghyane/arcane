export const enum Mod {
	Bold = 1,
	Dim = 2,
	Italic = 4,
	Underline = 8,
	Blink = 16,
	Reverse = 32,
	Hidden = 64,
	Strikethrough = 128,
}

export const NO_COLOR = 0;

export function packRgb(r: number, g: number, b: number): number {
	return (1 << 24) | (r << 16) | (g << 8) | b;
}

export function unpackRgb(packed: number): [r: number, g: number, b: number] {
	return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

export function hasColor(packed: number): boolean {
	return (packed & (1 << 24)) !== 0;
}

export interface Style {
	fg: number;
	bg: number;
	mods: number;
	link: string;
}

export const DEFAULT_STYLE: Style = { fg: NO_COLOR, bg: NO_COLOR, mods: 0, link: "" };

export interface Cell {
	char: string;
	width: number;
	style: Style;
}

export function emptyCell(): Cell {
	return { char: " ", width: 1, style: { ...DEFAULT_STYLE } };
}

export function cellsEqual(a: Cell, b: Cell): boolean {
	if (a.char !== b.char || a.width !== b.width) return false;
	if (a.style === b.style) return true;
	return (
		a.style.fg === b.style.fg &&
		a.style.bg === b.style.bg &&
		a.style.mods === b.style.mods &&
		a.style.link === b.style.link
	);
}

// 256-color palette → packed RGB
const PALETTE_256: number[] = (() => {
	const p: number[] = new Array(256);

	// Standard 16 colors (xterm defaults)
	const base16: [number, number, number][] = [
		[0, 0, 0],
		[128, 0, 0],
		[0, 128, 0],
		[128, 128, 0],
		[0, 0, 128],
		[128, 0, 128],
		[0, 128, 128],
		[192, 192, 192],
		[128, 128, 128],
		[255, 0, 0],
		[0, 255, 0],
		[255, 255, 0],
		[0, 0, 255],
		[255, 0, 255],
		[0, 255, 255],
		[255, 255, 255],
	];
	for (let i = 0; i < 16; i++) {
		p[i] = packRgb(base16[i][0], base16[i][1], base16[i][2]);
	}

	// 6x6x6 color cube (indices 16-231)
	const vals = [0, 95, 135, 175, 215, 255];
	for (let i = 0; i < 216; i++) {
		const r = vals[Math.floor(i / 36)];
		const g = vals[Math.floor(i / 6) % 6];
		const b = vals[i % 6];
		p[16 + i] = packRgb(r, g, b);
	}

	// Grayscale ramp (indices 232-255)
	for (let i = 0; i < 24; i++) {
		const v = 8 + i * 10;
		p[232 + i] = packRgb(v, v, v);
	}

	return p;
})();

export function palette256ToRgb(index: number): number {
	return PALETTE_256[index] ?? NO_COLOR;
}
