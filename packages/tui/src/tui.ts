import { linesToBuffer } from "./buffer/ansi-parser.js";
import type { Buffer as CellBuffer, CellChange } from "./buffer/buffer.js";
import { Mod } from "./buffer/cell.js";
import { renderBuffer, renderDiff } from "./buffer/render.js";
import { isKeyRelease, matchesKey } from "./keys";
import { type MouseEvent, SCROLL_DOWN, SCROLL_UP, type Terminal } from "./terminal";
import { setCellDimensions, TERMINAL } from "./terminal-capabilities";
import { sliceByColumn, visibleWidth } from "./utils";

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

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

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	terminal: Terminal;
	#previousLines: string[] = [];
	#previousWidth = 0;
	#focusedComponent: Component | null = null;
	#inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	onDebug?: () => void;
	#renderRequested = false;
	#hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	#inputBuffer = ""; // Buffer for parsing terminal responses
	#cellSizeQueryPending = false;
	#showHardwareCursor = process.env.ARCANE_HARDWARE_CURSOR === "1";
	#clearOnShrink = process.env.ARCANE_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off, enable with ARCANE_CLEAR_ON_SHRINK=1)
	#maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	#fullRedrawCount = 0;
	#clearScrollbackOnNextFullRender = false;
	#stopped = false;
	#scrollOffset = 0; // Lines scrolled up from bottom (0 = live, >0 = scrolled back)
	#scrollLines = 3; // Lines to scroll per wheel event
	#scrollPending = 0; // Accumulated scroll delta waiting to flush
	#scrollFlushScheduled = false; // Whether a flush is scheduled on next tick
	#fullRenderCache: string[] = []; // Cached full render output for native scroll
	#previousBuffer: CellBuffer | null = null; // Previous viewport buffer for cell-level diff

	// Selection state for mouse text selection
	#selectionActive = false;
	#selectionAnchor: { col: number; row: number } | null = null; // Start of selection (content coords)
	#selectionEnd: { col: number; row: number } | null = null; // End of selection (content coords)
	#selectionScrollTimer?: Timer; // Auto-scroll timer during edge drag

	// Overlay stack for modal components rendered on top of base content
	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.#showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.#clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.#clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.#focusedComponent)) {
			this.#focusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false };
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.#focusedComponent === component) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.#focusedComponent === component) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (this.#isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		// Find topmost visible overlay, or fall back to preFocus
		const topVisible = this.#getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some(o => this.#isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	#isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible overlay, if any */
	#getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.#stopped = false;
		this.terminal.start(
			data => this.#handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.onMouse(event => this.#handleMouse(event));
		this.terminal.hideCursor();
		this.#queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: InputListener): () => void {
		this.#inputListeners.add(listener);
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	#queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!TERMINAL.imageProtocol) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.#cellSizeQueryPending = true;
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.#stopped = true;
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.#previousLines.length > 0) {
			const targetRow = this.#previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.#hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false): void {
		if (force) {
			this.#previousLines = [];
			this.#previousBuffer = null;
			this.#previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.#hardwareCursorRow = 0;
			this.#maxLinesRendered = 0;
			this.#clearScrollbackOnNextFullRender = true;
		}
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		process.nextTick(() => {
			this.#renderRequested = false;
			this.#doRender();
		});
	}

	/**
	 * Scroll viewport using native terminal scroll commands (CSI S / CSI T).
	 * Positive delta = scroll up (view earlier content), negative = scroll down.
	 * No component re-render — reads from #fullRenderCache.
	 */
	#nativeScroll(delta: number): void {
		const cache = this.#fullRenderCache;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (cache.length <= height) return;

		const maxScroll = cache.length - height;
		const prevOffset = this.#scrollOffset;
		this.#scrollOffset = Math.max(0, Math.min(maxScroll, this.#scrollOffset + delta));
		if (this.#scrollOffset === prevOffset) return;

		const viewportStart = cache.length - height - this.#scrollOffset;
		const viewportLines = cache.slice(viewportStart, viewportStart + height);

		// Convert new viewport to cell buffer and diff against previous
		const currentBuffer = linesToBuffer(viewportLines, width, height);

		let out = "\x1b[?2026h";
		if (this.#previousBuffer) {
			const changes = currentBuffer.diff(this.#previousBuffer);
			if (changes.length > 0) {
				out += renderDiff(changes, width);
			}
		} else {
			// No previous buffer — full viewport redraw
			out += "\x1b[H";
			for (let i = 0; i < viewportLines.length; i++) {
				if (i > 0) out += "\r\n";
				out += `\x1b[2K${viewportLines[i]}`;
			}
		}
		out += "\x1b[?25l\x1b[?2026l";
		this.terminal.write(out);

		this.#previousBuffer = currentBuffer;
		this.#previousLines = viewportLines;
		this.#hardwareCursorRow = Math.max(0, viewportLines.length - 1);
		this.#maxLinesRendered = height;
	}

	#handleInput(data: string): void {
		// Clear any active selection on keyboard input
		if (this.#selectionActive) this.#clearSelection();
		// Handle scroll wheel events — batch and flush on next tick
		if (data === SCROLL_UP || data === SCROLL_DOWN) {
			this.#scrollPending += data === SCROLL_UP ? this.#scrollLines : -this.#scrollLines;
			if (!this.#scrollFlushScheduled) {
				this.#scrollFlushScheduled = true;
				process.nextTick(() => {
					this.#scrollFlushScheduled = false;
					const delta = this.#scrollPending;
					this.#scrollPending = 0;
					if (delta !== 0) this.#nativeScroll(delta);
				});
			}
			return;
		}
		// Any other input resets scroll to bottom (live mode)
		// Force full re-render to resync diff engine state with terminal
		if (this.#scrollOffset > 0) {
			this.#scrollOffset = 0;
			this.requestRender(true);
		}

		if (this.#inputListeners.size > 0) {
			let current = data;
			for (const listener of this.#inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// If we're waiting for cell size response, buffer input and parse
		if (this.#cellSizeQueryPending) {
			this.#inputBuffer += data;
			const filtered = this.#parseCellSizeResponse();
			if (filtered.length === 0) return;
			data = filtered;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
		if (focusedOverlay && !this.#isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.#getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.#focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.#focusedComponent.wantsKeyRelease) {
				return;
			}
			this.#focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	#handleMouse(event: MouseEvent): void {
		const height = this.terminal.rows;
		const cache = this.#fullRenderCache;
		if (cache.length === 0) return;

		const viewportTop = Math.max(0, cache.length - height - this.#scrollOffset);
		const contentRow = viewportTop + event.row - 1;
		const contentCol = event.col - 1;

		switch (event.type) {
			case "press":
				if (event.button === 0) {
					if (this.#selectionActive) this.#renderSelection(false);
					this.#selectionActive = true;
					this.#selectionAnchor = { col: contentCol, row: contentRow };
					this.#selectionEnd = { col: contentCol, row: contentRow };
				}
				break;
			case "drag":
				if (this.#selectionActive && this.#selectionAnchor) {
					this.#renderSelection(false);
					this.#selectionEnd = { col: contentCol, row: contentRow };
					this.#renderSelection(true);

					// Auto-scroll when dragging at viewport edges
					const scrollDir = event.row <= 1 ? 1 : event.row >= height ? -1 : 0;
					if (scrollDir !== 0 && !this.#selectionScrollTimer) {
						this.#selectionScrollTimer = setInterval(() => {
							if (!this.#selectionActive) {
								clearInterval(this.#selectionScrollTimer);
								this.#selectionScrollTimer = undefined;
								return;
							}
							this.#renderSelection(false);
							this.#nativeScroll(scrollDir * this.#scrollLines);
							// Update selection end to follow scroll
							const cache = this.#fullRenderCache;
							const vt = Math.max(0, cache.length - height - this.#scrollOffset);
							const newRow = scrollDir > 0 ? vt : vt + height - 1;
							this.#selectionEnd = { col: this.#selectionEnd!.col, row: newRow };
							this.#renderSelection(true);
						}, 80);
					} else if (scrollDir === 0 && this.#selectionScrollTimer) {
						clearInterval(this.#selectionScrollTimer);
						this.#selectionScrollTimer = undefined;
					}
				}
				break;
			case "release":
				if (this.#selectionScrollTimer) {
					clearInterval(this.#selectionScrollTimer);
					this.#selectionScrollTimer = undefined;
				}
				if (this.#selectionActive && this.#selectionAnchor && this.#selectionEnd) {
					this.#copySelectionToClipboard();
					setTimeout(() => this.#clearSelection(), 150);
				}
				break;
		}
	}

	#clearSelection(): void {
		if (this.#selectionScrollTimer) {
			clearInterval(this.#selectionScrollTimer);
			this.#selectionScrollTimer = undefined;
		}
		if (!this.#selectionActive) return;
		this.#renderSelection(false);
		this.#selectionActive = false;
		this.#selectionAnchor = null;
		this.#selectionEnd = null;
		this.requestRender();
	}

	#getSelectionRange(): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
		if (!this.#selectionAnchor || !this.#selectionEnd) return null;
		const a = this.#selectionAnchor;
		const b = this.#selectionEnd;
		if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
			return { startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
		}
		return { startRow: b.row, startCol: b.col, endRow: a.row, endCol: a.col };
	}

	/** Render or clear selection by toggling Reverse bit on buffer cells */
	#renderSelection(highlight: boolean): void {
		const range = this.#getSelectionRange();
		if (!range) return;
		const { startRow, startCol, endRow, endCol } = range;
		if (startRow === endRow && startCol === endCol) return;

		const buf = this.#previousBuffer;
		if (!buf) return;

		const cache = this.#fullRenderCache;
		const height = this.terminal.rows;
		const width = this.terminal.columns;
		const viewportTop = Math.max(0, cache.length - height - this.#scrollOffset);

		// Collect cells that need Reverse toggled
		const changes: CellChange[] = [];

		for (let row = startRow; row <= endRow && row < cache.length; row++) {
			const screenRow = row - viewportTop;
			if (screenRow < 0 || screenRow >= height) continue;
			if (TERMINAL.isImageLine(cache[row])) continue;

			const colStart = row === startRow ? startCol : 0;
			const colEnd = row === endRow ? endCol : width;

			for (let col = colStart; col < colEnd && col < width; col++) {
				const cell = buf.get(col, screenRow);
				if (cell.width === 0) continue; // Skip wide-char placeholders

				const hasReverse = (cell.style.mods & Mod.Reverse) !== 0;
				if (highlight && !hasReverse) {
					const newCell = {
						char: cell.char,
						width: cell.width,
						style: { ...cell.style, mods: cell.style.mods | Mod.Reverse },
					};
					buf.set(col, screenRow, newCell);
					changes.push({ col, row: screenRow, cell: newCell });
				} else if (!highlight && hasReverse) {
					const newCell = {
						char: cell.char,
						width: cell.width,
						style: { ...cell.style, mods: cell.style.mods & ~Mod.Reverse },
					};
					buf.set(col, screenRow, newCell);
					changes.push({ col, row: screenRow, cell: newCell });
				}
			}
		}

		if (changes.length === 0) return;

		// Output only the changed cells
		let out = "\x1b[?2026h"; // Synchronized output
		out += "\x1b7"; // Save cursor position
		out += renderDiff(changes, width);
		out += "\x1b8"; // Restore cursor position
		out += "\x1b[?2026l";
		this.terminal.write(out);
	}

	#copySelectionToClipboard(): void {
		const range = this.#getSelectionRange();
		if (!range) return;
		const { startRow, startCol, endRow, endCol } = range;
		if (startRow === endRow && startCol === endCol) return;

		const cache = this.#fullRenderCache;
		if (cache.length === 0) return;

		const textLines: string[] = [];
		for (let row = startRow; row <= endRow && row < cache.length; row++) {
			if (row < 0) continue;
			const line = cache[row];
			if (TERMINAL.isImageLine(line)) continue;
			const lineStart = row === startRow ? startCol : 0;
			const isFullLine = row !== endRow;
			const lineEnd = isFullLine ? visibleWidth(line) : endCol;
			const sliced = sliceByColumn(line, lineStart, lineEnd - lineStart, true);
			// Strip ANSI from the sliced segment
			const plain = sliced.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g, "");
			textLines.push(isFullLine ? plain.trimEnd() : plain);
		}

		const text = textLines.join("\n");
		if (text.length === 0) return;

		const b64 = Buffer.from(text).toString("base64");
		this.terminal.write(`\x1b]52;c;${b64}\x07`);
		TERMINAL.sendNotification("Copied to clipboard");
	}

	#parseCellSizeResponse(): string {
		// Response format: ESC [ 6 ; height ; width t
		// Match the response pattern
		const responsePattern = /\x1b\[6;(\d+);(\d+)t/;
		const match = this.#inputBuffer.match(responsePattern);

		if (match) {
			const heightPx = parseInt(match[1], 10);
			const widthPx = parseInt(match[2], 10);

			if (heightPx > 0 && widthPx > 0) {
				setCellDimensions({ widthPx, heightPx });
				// Invalidate all components so images re-render with correct dimensions
				this.invalidate();
				this.requestRender();
			}

			// Remove the response from buffer
			this.#inputBuffer = this.#inputBuffer.replace(responsePattern, "");
			this.#cellSizeQueryPending = false;
		}

		// Check if we have a partial cell size response starting (wait for more data)
		// Patterns that could be incomplete cell size response: \x1b, \x1b[, \x1b[6, \x1b[6;...(no t yet)
		const partialCellSizePattern = /\x1b(\[6?;?[\d;]*)?$/;
		if (partialCellSizePattern.test(this.#inputBuffer)) {
			// Check if it's actually a complete different escape sequence (ends with a letter)
			// Cell size response ends with 't', Kitty keyboard ends with 'u', arrows end with A-D, etc.
			const lastChar = this.#inputBuffer[this.#inputBuffer.length - 1];
			if (!/[a-zA-Z~]/.test(lastChar)) {
				// Doesn't end with a terminator, might be incomplete - wait for more
				return "";
			}
		}

		// No cell size response found, return buffered data as user input
		const result = this.#inputBuffer;
		this.#inputBuffer = "";
		this.#cellSizeQueryPending = false; // Give up waiting
		return result;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	#resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.#resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.#resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.#resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.#resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	#resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	#resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}
	/** Composite overlays directly onto a cell buffer instead of string splicing. */
	#compositeOverlaysOnBuffer(buf: CellBuffer, termWidth: number, termHeight: number): void {
		for (const entry of this.overlayStack) {
			if (!this.#isOverlayVisible(entry)) continue;

			const { component, options } = entry;
			const { width, maxHeight } = this.#resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render overlay component to string lines (bridge — components still return strings)
			let overlayLines = component.render(width);
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			const { row, col } = this.#resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			// Convert overlay to a small buffer and copy onto the main buffer
			const overlayBuf = linesToBuffer(overlayLines, width, overlayLines.length);
			buf.copyFrom(overlayBuf, { x: 0, y: 0, width, height: overlayLines.length }, col, row);
		}
	}

	#applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!TERMINAL.isImageLine(line)) {
				lines[i] = line + reset;
			}
		}
		return lines;
	}
	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	#extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	#doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Render all components to get new lines
		let newLines = this.render(width);

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.#extractCursorPosition(newLines, height);

		newLines = this.#applyLineResets(newLines);

		// Cache base render output for native scroll and selection (without overlays)
		const prevCacheLength = this.#fullRenderCache.length;
		this.#fullRenderCache = newLines.slice();

		// Anchor viewport when content grows while scrolled back
		if (this.#scrollOffset > 0) {
			const growth = newLines.length - prevCacheLength;
			if (growth > 0) {
				this.#scrollOffset += growth;
			}
			const maxScroll = Math.max(0, newLines.length - height);
			this.#scrollOffset = Math.min(this.#scrollOffset, maxScroll);
		}

		// Determine visible viewport
		let viewportLines: string[];
		if (this.#scrollOffset > 0) {
			const viewportStart = newLines.length - height - this.#scrollOffset;
			viewportLines = newLines.slice(Math.max(0, viewportStart), Math.max(0, viewportStart) + height);
		} else {
			const start = Math.max(0, newLines.length - height);
			viewportLines = newLines.slice(start);
		}

		// Convert viewport to cell buffer
		const currentBuffer = linesToBuffer(viewportLines, width, height);

		// Composite overlays directly onto the buffer
		if (this.overlayStack.length > 0) {
			this.#compositeOverlaysOnBuffer(currentBuffer, width, height);
		}

		// Width changed — invalidate previous buffer (cell positions shift)
		const widthChanged = this.#previousWidth !== 0 && this.#previousWidth !== width;
		if (widthChanged) {
			this.#previousBuffer = null;
		}

		if (!this.#previousBuffer) {
			// No previous buffer — full render
			this.#fullRedrawCount += 1;
			let out = "\x1b[?2026h"; // Begin synchronized output
			out += this.#clearScrollbackOnNextFullRender ? "\x1b[3J\x1b[2J\x1b[H" : "\x1b[2J\x1b[H";
			const renderedLines = renderBuffer(currentBuffer);
			for (let i = 0; i < renderedLines.length; i++) {
				if (i > 0) out += "\r\n";
				out += renderedLines[i];
			}
			const renderCursorRow = Math.max(0, renderedLines.length - 1);
			const cursorUpdate = this.#buildHardwareCursorSequence(
				cursorPos ? { row: cursorPos.row - Math.max(0, newLines.length - height), col: cursorPos.col } : null,
				viewportLines.length,
				renderCursorRow,
			);
			out += cursorUpdate.sequence;
			out += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(out);
			this.#hardwareCursorRow = cursorUpdate.row;
			this.#maxLinesRendered = viewportLines.length;
			this.#clearScrollbackOnNextFullRender = false;
		} else {
			// Cell-level diff against previous buffer
			const changes = currentBuffer.diff(this.#previousBuffer);

			if (changes.length === 0) {
				// No visual changes — just update cursor if needed
				if (cursorPos) {
					const adjCursorPos = { row: cursorPos.row - Math.max(0, newLines.length - height), col: cursorPos.col };
					const update = this.#buildHardwareCursorSequence(
						adjCursorPos,
						viewportLines.length,
						this.#hardwareCursorRow,
					);
					this.terminal.write(update.sequence);
					this.#hardwareCursorRow = update.row;
				}
			} else {
				// Emit minimal ANSI for changed cells
				let out = "\x1b[?2026h"; // Begin synchronized output
				out += renderDiff(changes, width);
				const adjCursorPos = cursorPos
					? { row: cursorPos.row - Math.max(0, newLines.length - height), col: cursorPos.col }
					: null;
				// After renderDiff, cursor position is unknown — use absolute positioning
				const lastChange = changes[changes.length - 1];
				const cursorUpdate = this.#buildHardwareCursorSequence(adjCursorPos, viewportLines.length, lastChange.row);
				out += cursorUpdate.sequence;
				out += "\x1b[?2026l"; // End synchronized output
				this.terminal.write(out);
				this.#hardwareCursorRow = cursorUpdate.row;
			}
			this.#maxLinesRendered = Math.max(this.#maxLinesRendered, viewportLines.length);
		}

		this.#previousBuffer = currentBuffer;
		this.#previousLines = viewportLines;
		this.#previousWidth = width;

		// Re-apply selection highlight after render so it survives streaming updates
		if (this.#selectionActive) {
			this.#renderSelection(true);
		}
	}

	/**
	 * Build cursor movement and visibility escape sequence and return resulting row.
	 * Used by differential and direct cursor updates to keep movement logic consistent.
	 */
	#buildHardwareCursorSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		currentRow: number,
	): { sequence: string; row: number } {
		if (!cursorPos || totalLines <= 0) {
			return { sequence: "\x1b[?25l", row: currentRow };
		}
		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);
		let sequence = "";
		const rowDelta = targetRow - currentRow;
		if (rowDelta > 0) {
			sequence += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			sequence += `\x1b[${-rowDelta}A`; // Move up
		}
		sequence += `\x1b[${targetCol + 1}G`; // Move to absolute column (1-indexed)
		sequence += this.#showHardwareCursor ? "\x1b[?25h" : "\x1b[?25l";

		return { sequence, row: targetRow };
	}
}
