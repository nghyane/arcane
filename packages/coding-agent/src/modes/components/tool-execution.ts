import type { AgentTool } from "@nghyane/arcane-agent";
import { sanitizeText } from "@nghyane/arcane-natives";
import {
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	ImageProtocol,
	imageFallback,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@nghyane/arcane-tui";
import { logger } from "@nghyane/arcane-utils";
import { getProjectDir } from "@nghyane/arcane-utils/dirs";
import { theme } from "../../modes/theme/theme";
import {
	computeEditDiff,
	computeHashlineDiff,
	computePatchDiff,
	type EditDiffError,
	type EditDiffResult,
} from "../../patch";
import { BASH_DEFAULT_PREVIEW_LINES } from "../../tools/bash";
import { defaultRenderer } from "../../tools/default-renderer";
import { PYTHON_DEFAULT_PREVIEW_LINES } from "../../tools/python";
import { convertToPng } from "../../utils/image-convert";
import { renderDiff } from "./diff";

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
	editFuzzyThreshold?: number;
	editAllowFuzzy?: boolean;
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
	#imageComponents: Image[] = [];
	#imageSpacers: Spacer[] = [];
	#toolName: string;
	#toolLabel: string;
	#tool: AgentTool | undefined;
	#args: any;
	#expanded = false;
	#showImages: boolean;
	#editFuzzyThreshold: number | undefined;
	#editAllowFuzzy: boolean | undefined;
	#isPartial = true;
	#compact: boolean;
	#ui: TUI;
	#cwd: string;
	#result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	#editDiffPreview?: EditDiffResult | EditDiffError;
	#editDiffArgsKey?: string; // Track which args the preview is for
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	#convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
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
		this.#editFuzzyThreshold = options.editFuzzyThreshold;
		this.#editAllowFuzzy = options.editAllowFuzzy;
		this.#compact = compact;
		this.#ui = ui;
		this.#cwd = cwd;

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
		this.#maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 */
	#maybeComputeEditDiff(): void {
		if (this.#toolName !== "edit") return;

		const path = this.#args?.path;
		const op = this.#args?.op;

		if (op) {
			const diff = this.#args?.diff;
			const rename = this.#args?.rename;
			if (!path) return;

			const argsKey = JSON.stringify({ path, op, rename, diff });
			if (this.#editDiffArgsKey === argsKey) return;
			this.#editDiffArgsKey = argsKey;

			computePatchDiff({ path, op, rename, diff }, this.#cwd, {
				fuzzyThreshold: this.#editFuzzyThreshold,
				allowFuzzy: this.#editAllowFuzzy,
			}).then(result => {
				if (this.#editDiffArgsKey === argsKey) {
					this.#editDiffPreview = result;
					this.#updateDisplay();
					this.#ui.requestRender();
				}
			});
			return;
		}
		const edits = this.#args?.edits;
		if (path && Array.isArray(edits)) {
			const argsKey = JSON.stringify({ path, edits });
			if (this.#editDiffArgsKey === argsKey) return;
			this.#editDiffArgsKey = argsKey;

			computeHashlineDiff({ path, edits }, this.#cwd).then(result => {
				if (this.#editDiffArgsKey === argsKey) {
					this.#editDiffPreview = result;
					this.#updateDisplay();
					this.#ui.requestRender();
				}
			});
			return;
		}

		const oldText = this.#args?.old_text;
		const newText = this.#args?.new_text;
		const all = this.#args?.all;

		// Need all three params to compute diff
		if (!path || oldText === undefined || newText === undefined) return;

		// Create a key to track which args this computation is for
		const argsKey = JSON.stringify({ path, oldText, newText, all });

		// Skip if we already computed for these exact args
		if (this.#editDiffArgsKey === argsKey) return;

		this.#editDiffArgsKey = argsKey;

		// Compute diff async
		computeEditDiff(path, oldText, newText, this.#cwd, true, all, this.#editFuzzyThreshold).then(result => {
			// Only update if args haven't changed since we started
			if (this.#editDiffArgsKey === argsKey) {
				this.#editDiffPreview = result;
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
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.#maybeConvertImagesForKitty();
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
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	#maybeConvertImagesForKitty(): void {
		// Only needed for Kitty protocol
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		if (!this.#result) return;

		const imageBlocks = this.#getAllImageBlocks();

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.#convertedImages.has(i)) continue;

			// Convert async - catch errors from processing
			const index = i;
			convertToPng(img.data, img.mimeType)
				.then(converted => {
					if (converted) {
						this.#convertedImages.set(index, converted);
						this.#updateDisplay();
						this.#ui.requestRender();
					}
				})
				.catch(() => {
					// Ignore conversion failures - display will use original image format
				});
		}
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

		// Handle images (same for both custom and built-in)
		for (const img of this.#imageComponents) {
			this.removeChild(img);
		}
		this.#imageComponents = [];
		for (const spacer of this.#imageSpacers) {
			this.removeChild(spacer);
		}
		this.#imageSpacers = [];

		if (this.#result) {
			const imageBlocks = this.#getAllImageBlocks();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (TERMINAL.imageProtocol && this.#showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.#convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (TERMINAL.imageProtocol === ImageProtocol.Kitty && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.#imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
					);
					this.#imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
	}

	#getCallArgsForRender(): any {
		if (this.#toolName !== "edit") {
			return this.#args;
		}
		if (!this.#editDiffPreview || !("diff" in this.#editDiffPreview) || !this.#editDiffPreview.diff) {
			return this.#args;
		}
		return { ...(this.#args as Record<string, unknown>), previewDiff: this.#editDiffPreview.diff };
	}

	/**
	 * Build render context for tools that need extra state (bash, python, edit)
	 */
	#buildRenderContext(): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		const normalizeTimeoutSeconds = (value: unknown, maxSeconds: number): number | undefined => {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			return Math.max(1, Math.min(maxSeconds, value));
		};

		if (this.#toolName === "bash" && this.#result) {
			// Pass raw output and expanded state - renderer handles width-aware truncation
			const output = this.#getTextOutput().trimEnd();
			context.output = output;
			context.expanded = this.#expanded;
			context.previewLines = BASH_DEFAULT_PREVIEW_LINES;
			context.timeout = normalizeTimeoutSeconds(this.#args?.timeout, 3600);
		} else if (this.#toolName === "python" && this.#result) {
			const output = this.#getTextOutput().trimEnd();
			context.output = output;
			context.expanded = this.#expanded;
			context.previewLines = PYTHON_DEFAULT_PREVIEW_LINES;
			context.timeout = normalizeTimeoutSeconds(this.#args?.timeout, 600);
		} else if (this.#toolName === "edit") {
			// Edit needs diff preview and renderDiff function
			context.editDiffPreview = this.#editDiffPreview;
			context.renderDiff = renderDiff;
		}

		return context;
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
			const imageIndicators = imageBlocks
				.map((img: any) => {
					const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
					return imageFallback(img.mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}
}
