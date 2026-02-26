import type { AgentTool } from "@nghyane/arcane-agent";
import { sanitizeText } from "@nghyane/arcane-natives";
import { Box, type Component, Container, Spacer, TERMINAL, Text, type TUI } from "@nghyane/arcane-tui";
import { logger } from "@nghyane/arcane-utils";
import { getProjectDir } from "@nghyane/arcane-utils/dirs";
import { theme } from "../../theme/theme";
import { defaultRenderer } from "../../tools/default-renderer";
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
	#contentBox: Box; // Used for custom tools and bash visual truncation
	#imageDisplay: ToolImageDisplay;
	#toolName: string;
	#toolLabel: string;
	#tool: AgentTool | undefined;
	#args: any;
	#expanded = false;
	#showImages: boolean;
	#isPartial = true;
	#compact: boolean;
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

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		tool: AgentTool | undefined,
		ui: TUI,
		cwd: string = getProjectDir(),
		{ compact = false }: { compact?: boolean } = {},
	) {
		super();
		this.#toolName = toolName;
		this.#toolLabel = tool?.label ?? toolName;
		this.#tool = tool;
		this.#args = cloneToolArgs(args);
		this.#showImages = options.showImages ?? true;
		this.#compact = compact;
		this.#ui = ui;
		this.#cwd = cwd;
		this.#imageDisplay = new ToolImageDisplay(this, () => {
			this.#updateDisplay();
			this.#ui.requestRender();
		});

		if (!compact) {
			this.addChild(new Spacer(1));
		}

		const px = compact ? 0 : 1;
		const py = compact ? 0 : 1;
		const initialBg = compact ? undefined : (text: string) => theme.bg("toolPendingBg", text);
		this.#contentBox = new Box(px, py, initialBg);
		this.addChild(this.#contentBox);

		this.#updateDisplay();
	}

	updateArgs(args: any, _toolCallId?: string): void {
		this.#args = cloneToolArgs(args);
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
		// Spinner for: task tool with partial result, or edit/write while args streaming
		const isStreamingArgs = !this.#argsComplete && (this.#toolName === "edit" || this.#toolName === "write");
		const isPartialTask = this.#isPartial && this.#tool?.mergeCallAndResult === true;
		const needsSpinner = isStreamingArgs || isPartialTask;
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

	#getBgFn(): ((text: string) => string) | undefined {
		if (this.#compact) return undefined;
		if (this.#isPartial) return (text: string) => theme.bg("toolPendingBg", text);
		if (this.#result?.isError) return (text: string) => theme.bg("toolErrorBg", text);
		return (text: string) => theme.bg("toolSuccessBg", text);
	}

	#updateDisplay(): void {
		const bgFn = this.#getBgFn();

		// Sync shared mutable render state for component closures
		this.#renderState.expanded = this.#expanded;
		this.#renderState.isPartial = this.#isPartial;
		this.#renderState.spinnerFrame = this.#spinnerFrame;

		const isInline = this.#tool?.inline ?? false;
		const mergeCallAndResult = this.#tool?.mergeCallAndResult ?? false;
		this.#contentBox.setBgFn(isInline ? undefined : bgFn);
		this.#contentBox.clear();

		// Pass label for default renderer
		this.#renderState.label = this.#toolLabel;

		const shouldRenderCall = !this.#result || !mergeCallAndResult;
		if (shouldRenderCall) {
			try {
				const callComponent = (this.#tool?.renderCall ?? defaultRenderer.renderCall)(
					this.#getCallArgsForRender(),
					this.#renderState,
					theme,
				);
				if (callComponent) {
					this.#contentBox.addChild(ensureInvalidate(callComponent));
				}
			} catch (err) {
				logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
				this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
			}
		}

		if (this.#result) {
			try {
				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				const resultComponent = (this.#tool?.renderResult ?? defaultRenderer.renderResult)(
					{
						content: this.#result.content as any,
						details: this.#result.details,
						isError: this.#result.isError,
					},
					this.#renderState,
					theme,
					this.#args,
				);
				if (resultComponent) {
					this.#contentBox.addChild(ensureInvalidate(resultComponent));
				}
			} catch (err) {
				logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
				const output = this.#getTextOutput();
				if (output) {
					this.#contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
				}
			}
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
