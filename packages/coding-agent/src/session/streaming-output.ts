import { sanitizeText } from "@nghyane/arcane-natives";

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_MAX_LINES = 3000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const DEFAULT_MAX_COLUMN = 1024; // Max chars per grep match line

// =============================================================================
// Interfaces
// =============================================================================

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

export interface OutputSummary {
	output: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	/** Artifact ID for internal URL access (artifact://<id>) when truncated */
	artifactId?: string;
}

export interface OutputSinkOptions {
	artifactPath?: string;
	artifactId?: string;
	spillThreshold?: number;
	onChunk?: (chunk: string) => void;
}

export interface TailTruncationNoticeOptions {
	/** Path to full output file (e.g., from bash/python executor) */
	fullOutputPath?: string;
	/** Original content for computing last line size when lastLinePartial */
	originalContent?: string;
	/** Additional suffix to append inside the brackets */
	suffix?: string;
}

export interface HeadTruncationNoticeOptions {
	/** 1-indexed start line number (default: 1) */
	startLine?: number;
	/** Total lines in the original file (for "of N" display) */
	totalFileLines?: number;
}

// =============================================================================
// Internal helpers
// =============================================================================

function countNewlines(text: string): number {
	let count = 0;
	let idx = text.indexOf("\n");
	while (idx !== -1) {
		count++;
		idx = text.indexOf("\n", idx + 1);
	}
	return count;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return countNewlines(text) + 1;
}

/**
 * Zero-copy Buffer view over a Uint8Array.
 * Returns the input as-is if already a Buffer.
 */
export function asBuffer(data: Uint8Array): Buffer {
	if (Buffer.isBuffer(data)) return data;
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Advance past UTF-8 continuation bytes (0x80..0xBF) at the given position.
 * Returns the index of the first non-continuation byte at or after `pos`.
 */
function findUtf8BoundaryForward(buf: Buffer, pos: number): number {
	while (pos < buf.length && (buf[pos] & 0xc0) === 0x80) {
		pos++;
	}
	return pos;
}

/**
 * Retreat past UTF-8 continuation bytes at the given position.
 * Returns the index of the first non-continuation byte at or before `cut`.
 */
function findUtf8BoundaryBackward(buf: Buffer, cut: number): number {
	while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
		cut--;
	}
	return cut;
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	const start = findUtf8BoundaryForward(buf, buf.length - maxBytes);
	return buf.subarray(start).toString("utf-8");
}

export function truncateStringToBytesFromStart(str: string, maxBytes: number): { text: string; bytes: number } {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return { text: str, bytes: buf.length };
	}

	const end = findUtf8BoundaryBackward(buf, maxBytes);

	if (end <= 0) {
		return { text: "", bytes: 0 };
	}

	const text = buf.subarray(0, end).toString("utf-8");
	return { text, bytes: Buffer.byteLength(text, "utf-8") };
}

// =============================================================================
// Public truncation functions
// =============================================================================

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Check if first line alone exceeds byte limit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a single line to max characters, adding truncation suffix.
 * Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = DEFAULT_MAX_COLUMN,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}…`, wasTruncated: true };
}

// =============================================================================
// Truncation notice formatters
// =============================================================================

/**
 * Format a truncation notice for tail-truncated output (bash/python).
 * Returns empty string if not truncated.
 */
export function formatTailTruncationNotice(
	truncation: TruncationResult,
	options: TailTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) {
		return "";
	}

	const { fullOutputPath, originalContent, suffix = "" } = options;
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	const fullOutputPart = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

	let notice: string;

	if (truncation.lastLinePartial) {
		let lastLineSizePart = "";
		if (originalContent) {
			const lastLine = originalContent.split("\n").pop() || "";
			lastLineSizePart = ` (line is ${formatBytes(Buffer.byteLength(lastLine, "utf-8"))})`;
		}
		notice = `[Showing last ${formatBytes(truncation.outputBytes)} of line ${endLine}${lastLineSizePart}${fullOutputPart}${suffix}]`;
	} else if (truncation.truncatedBy === "lines") {
		notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutputPart}${suffix}]`;
	} else {
		notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatBytes(truncation.maxBytes)} limit)${fullOutputPart}${suffix}]`;
	}

	return `\n\n${notice}`;
}

/**
 * Format a truncation notice for head-truncated output (read tool).
 * Returns empty string if not truncated.
 */
export function formatHeadTruncationNotice(
	truncation: TruncationResult,
	options: HeadTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) {
		return "";
	}

	const startLineDisplay = options.startLine ?? 1;
	const totalFileLines = options.totalFileLines ?? truncation.totalLines;
	const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
	const nextOffset = endLineDisplay + 1;

	let notice: string;

	if (truncation.truncatedBy === "lines") {
		notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
	} else {
		notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatBytes(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue]`;
	}

	return `\n\n${notice}`;
}

// =============================================================================
// formatBytes (formerly formatSize)
// =============================================================================

/**
 * Format bytes as human-readable size.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	} else {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
	}
}

// =============================================================================
// OutputSink
// =============================================================================

/**
 * Line-buffered output sink with file spill support.
 *
 * Uses a single string buffer with line position tracking.
 * When memory limit exceeded, spills ~half to file in one batch operation.
 */
export class OutputSink {
	#buffer = "";
	#bufferBytes = 0;
	#totalLines = 0;
	#totalBytes = 0;
	#sawData = false;
	#truncated = false;
	#file?: {
		path: string;
		artifactId?: string;
		sink: Bun.FileSink;
	};
	readonly #artifactPath?: string;
	readonly #artifactId?: string;
	readonly #spillThreshold: number;
	readonly #onChunk?: (chunk: string) => void;

	constructor(options?: OutputSinkOptions) {
		const { artifactPath, artifactId, spillThreshold = DEFAULT_MAX_BYTES, onChunk } = options ?? {};

		this.#artifactPath = artifactPath;
		this.#artifactId = artifactId;
		this.#spillThreshold = spillThreshold;
		this.#onChunk = onChunk;
	}

	async #pushSanitized(data: string): Promise<void> {
		this.#onChunk?.(data);

		const dataBytes = Buffer.byteLength(data, "utf-8");
		this.#totalBytes += dataBytes;
		if (data.length > 0) {
			this.#sawData = true;
			this.#totalLines += countNewlines(data);
		}

		const bufferOverflow = this.#bufferBytes + dataBytes > this.#spillThreshold;
		const overflow = this.#file || bufferOverflow;
		const sink = overflow ? await this.#fileSink() : null;

		this.#buffer += data;
		this.#bufferBytes += dataBytes;
		await sink?.write(data);

		if (bufferOverflow) {
			this.#truncated = true;
			const buf = Buffer.from(this.#buffer, "utf-8");
			const start = findUtf8BoundaryForward(buf, buf.length - this.#spillThreshold);
			this.#buffer = buf.subarray(start).toString("utf-8");
			this.#bufferBytes = Buffer.byteLength(this.#buffer, "utf-8");
		}
		if (this.#file) {
			this.#truncated = true;
		}
	}

	async #fileSink(): Promise<Bun.FileSink | null> {
		if (!this.#artifactPath) return null;
		if (!this.#file) {
			try {
				this.#file = {
					path: this.#artifactPath,
					artifactId: this.#artifactId,
					sink: Bun.file(this.#artifactPath).writer(),
				};
				await this.#file.sink.write(this.#buffer);
			} catch {
				try {
					await this.#file?.sink?.end();
				} catch {}
				this.#file = undefined;
				return null;
			}
		}
		return this.#file.sink;
	}

	async push(chunk: string): Promise<void> {
		chunk = sanitizeText(chunk);
		await this.#pushSanitized(chunk);
	}

	createInput(): WritableStream<Uint8Array | string> {
		const dec = new TextDecoder("utf-8", { ignoreBOM: true });
		const finalize = async () => {
			await this.push(dec.decode());
		};

		return new WritableStream({
			write: async chunk => {
				if (typeof chunk === "string") {
					await this.push(chunk);
				} else {
					await this.push(dec.decode(chunk, { stream: true }));
				}
			},
			close: finalize,
			abort: finalize,
		});
	}

	async dump(notice?: string): Promise<OutputSummary> {
		const noticeLine = notice ? `[${notice}]\n` : "";
		const outputLines = countLines(this.#buffer);
		const outputBytes = this.#bufferBytes;
		const totalLines = this.#sawData ? this.#totalLines + 1 : 0;
		const totalBytes = this.#totalBytes;

		if (this.#file) {
			await this.#file.sink.end();
		}

		return {
			output: `${noticeLine}${this.#buffer}`,
			truncated: this.#truncated,
			totalLines,
			totalBytes,
			outputLines,
			outputBytes,
			artifactId: this.#file?.artifactId,
		};
	}
}
