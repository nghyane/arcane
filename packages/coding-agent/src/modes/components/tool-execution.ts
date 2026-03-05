import type { AgentTool } from "@nghyane/arcane-agent";
import { sanitizeText } from "@nghyane/arcane-natives";
import { Box, type Component, Container, Spacer, TERMINAL, Text, type TUI } from "@nghyane/arcane-tui";
import { logger } from "@nghyane/arcane-utils";
import { getProjectDir } from "@nghyane/arcane-utils/dirs";
import { theme } from "../../theme/theme";
import { defaultRenderer } from "../../tools/default-renderer";
import type { ToolTier } from "../../ui/render-utils";
import { ToolImageDisplay } from "./tool-image-display";

function ensureInvalidate(component: unknown): Component {
	const c = component as { render: Component["render"]; invalidate?: () => void };
	if (!c.invalidate) {
		c.invalidate = () => {};
	}
	return c as Component;
}

function cloneToolArgs<T>(args: T): T {
	if (args === null || args === undefined) return args;
	try {
		return structuredClone(args);
	} catch {
		return args;
	}
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
	tier?: ToolTier;
}

export interface ToolExecutionHandle {
	updateArgs(args: any, toolCallId?: string): void;
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial?: boolean,
		toolCallId?: string,
	): void;
	setArgsComplete(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
}

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	#contentBox: Box;
	#topSpacer?: Spacer;
	#tier: ToolTier;
	#imageDisplay: ToolImageDisplay;
	#toolName: string;
	#toolLabel: string;
	#tool: AgentTool | undefined;
	#args: any;
	#expanded = false;
	#showImages: boolean;
	#isPartial = true;
	#ui: TUI;
	#cwd: string;
	#result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: any;
	};
	// Tool-specific state from onArgsComplete (e.g. edit diff preview)
	#toolState?: unknown;
	#toolStateKey?: string;
	// Spinner animation for partial task results
	#spinnerFrame = 0;
	#spinnerInterval?: NodeJS.Timeout;
	// Track if args are still being streamed (for edit/write spinner)
	#argsComplete = false;
	#renderState: {
		spinnerFrame: number;
		expanded: boolean;
		isPartial: boolean;
		label?: string;
		renderContext?: Record<string, unknown>;
	} = {
		spinnerFrame: 0,
		expanded: false,
		isPartial: true,
	};
	// Cached components to avoid clear+rebuild flicker
	#structureKey = "";
	#cachedCallComponent?: Component;
	#cachedResultComponent?: Component;
	// Mutable result ref for subagent closures to read fresh data
	#resultRef: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: any;
		isError?: boolean;
	} = { content: [] };

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		tool: AgentTool | undefined,
		ui: TUI,
		cwd: string = getProjectDir(),
	) {
		super();
		this.#toolName = toolName;
		this.#toolLabel = tool?.label ?? toolName;
		this.#tool = tool;
		this.#args = cloneToolArgs(args);
		this.#showImages = options.showImages ?? true;
		this.#ui = ui;
		this.#cwd = cwd;
		this.#imageDisplay = new ToolImageDisplay(this, () => {
			this.#updateDisplay();
			this.#ui.requestRender();
		});

		this.#tier = options.tier ?? "default";
		const tier = this.#tier;
		if (tier === "quiet") {
			this.#contentBox = new Box(0, 0);
			this.addChild(this.#contentBox);
		} else {
			this.#topSpacer = new Spacer(1);
			this.addChild(this.#topSpacer);
			this.#contentBox = new Box(2, 0);
			this.addChild(this.#contentBox);
		}

		this.#updateSpinnerAnimation();
		this.#updateDisplay();
	}

	setMarginTop(lines: number): void {
		if (this.#topSpacer) {
			this.#topSpacer.setLines(lines);
		}
	}

	updateArgs(args: any, _toolCallId?: string): void {
		this.#args = cloneToolArgs(args);
		// Force call component rebuild — renderCall returns static content
		// that won't update on invalidate alone
		this.#structureKey = "";
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(_toolCallId?: string): void {
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		this.#callOnArgsComplete();
	}

	/**
	 * Delegate to tool.onArgsComplete when args are fully streamed.
	 * Stores result in #toolState for use by buildRenderContext.
	 */
	#callOnArgsComplete(): void {
		if (!this.#tool?.onArgsComplete) return;
		const argsKey = JSON.stringify(this.#args);
		if (this.#toolStateKey === argsKey) return;
		this.#toolStateKey = argsKey;

		this.#tool.onArgsComplete(this.#args, this.#cwd).then(state => {
			if (this.#toolStateKey === argsKey) {
				this.#toolState = state;
				this.#updateDisplay();
				this.#ui.requestRender();
			}
		});
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial = false,
		_toolCallId?: string,
	): void {
		this.#result = result;
		this.#isPartial = isPartial;
		// When tool is complete, ensure args are marked complete so spinner stops
		if (!isPartial) {
			this.#argsComplete = true;
		}
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		this.#imageDisplay.convertForKitty(this.#getAllImageBlocks());
	}

	/**
	 * Get all image blocks from result content and details.images.
	 * Some tools (like generate_image) store images in details to avoid bloating model context.
	 */
	#getAllImageBlocks(): Array<{ data?: string; mimeType?: string }> {
		if (!this.#result) return [];
		const contentImages = this.#result.content?.filter((c: any) => c.type === "image") || [];
		const detailImages = this.#result.details?.images || [];
		return [...contentImages, ...detailImages];
	}

	/**
	 * Start or stop spinner animation based on whether this is a partial task result.
	 */
	#updateSpinnerAnimation(): void {
		// Spinner runs whenever the tool hasn't produced a final result
		const needsSpinner = this.#isPartial || !this.#result || !this.#argsComplete;
		if (needsSpinner && !this.#spinnerInterval) {
			this.#spinnerInterval = setInterval(() => {
				const frameCount = theme.spinnerFrames.length;
				if (frameCount === 0) return;
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
				this.#renderState.spinnerFrame = this.#spinnerFrame;
				this.#ui.requestRender();
				// NO updateDisplay() — existing component closures read from renderState
			}, 80);
		} else if (!needsSpinner && this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	/**
	 * Stop spinner animation and cleanup resources.
	 */
	stopAnimation(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.#showImages = show;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		// Sync shared mutable render state for component closures
		this.#renderState.expanded = this.#expanded;
		this.#renderState.isPartial = this.#isPartial;
		this.#renderState.spinnerFrame = this.#spinnerFrame;
		this.#renderState.label = this.#toolLabel;

		const mergeCallAndResult = this.#tool?.mergeCallAndResult ?? true;

		// Determine which components are needed
		const needsCall = !this.#result || !mergeCallAndResult;
		const needsResult = !!this.#result;
		const structureKey = `${needsCall}|${needsResult}|${!!this.#toolState}`;

		// Update mutable result ref so existing closures read fresh data
		if (this.#result) {
			this.#resultRef.content = this.#result.content as any;
			this.#resultRef.details = this.#result.details;
			this.#resultRef.isError = this.#result.isError;
		}

		if (structureKey !== this.#structureKey) {
			// Structure changed — rebuild components
			this.#structureKey = structureKey;
			this.#contentBox.clear();
			this.#cachedCallComponent = undefined;
			this.#cachedResultComponent = undefined;

			if (needsCall) {
				try {
					const comp = (this.#tool?.renderCall ?? defaultRenderer.renderCall)(
						this.#getCallArgsForRender(),
						this.#renderState,
						theme,
					);
					if (comp) {
						this.#cachedCallComponent = ensureInvalidate(comp);
						this.#contentBox.addChild(this.#cachedCallComponent);
					}
				} catch (err) {
					logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					this.#cachedCallComponent = new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0);
					this.#contentBox.addChild(this.#cachedCallComponent);
				}
			}

			if (needsResult) {
				try {
					this.#renderState.renderContext = this.#buildRenderContext();
					const comp = (this.#tool?.renderResult ?? defaultRenderer.renderResult)(
						this.#resultRef as any,
						this.#renderState,
						theme,
						this.#args,
					);
					if (comp) {
						this.#cachedResultComponent = ensureInvalidate(comp);
						this.#contentBox.addChild(this.#cachedResultComponent);
					}
				} catch (err) {
					logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					const output = this.#getTextOutput();
					if (output) {
						this.#contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					}
				}
			}
		} else {
			// Structure unchanged — invalidate existing components so they re-render
			this.#renderState.renderContext = this.#buildRenderContext();
			this.#cachedCallComponent?.invalidate();
			this.#cachedResultComponent?.invalidate();
		}

		// Handle images
		if (this.#result) {
			this.#imageDisplay.update(this.#getAllImageBlocks(), this.#showImages, (s: string) =>
				theme.fg("toolOutput", s),
			);
		}
	}

	#getCallArgsForRender(): any {
		return this.#args;
	}

	/**
	 * Build render context. Delegates to tool.buildRenderContext if defined.
	 */
	#buildRenderContext(): Record<string, unknown> {
		if (this.#tool?.buildRenderContext) {
			return this.#tool.buildRenderContext({
				args: this.#args,
				result: this.#result as any,
				toolState: this.#toolState,
				expanded: this.#expanded,
				getTextOutput: () => this.#getTextOutput(),
			});
		}
		return {};
	}

	#getTextOutput(): string {
		if (!this.#result) return "";

		const textBlocks = this.#result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.#getAllImageBlocks();

		let output = textBlocks
			.map((c: any) => {
				return sanitizeText(c.text || "");
			})
			.join("\n");

		if (imageBlocks.length > 0 && (!TERMINAL.imageProtocol || !this.#showImages)) {
			const imageIndicators = ToolImageDisplay.fallbackText(imageBlocks);
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}
}
