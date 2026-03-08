/**
 * Apply head/tail limits to output text.
 *
 * If both head and tail are specified, head is applied first (take first N lines),
 * then tail is applied (take last M lines of that).
 */
export function applyHeadTail(
	text: string,
	headLines?: number,
	tailLines?: number,
): { text: string; applied: boolean; headApplied?: number; tailApplied?: number } {
	if (!headLines && !tailLines) {
		return { text, applied: false };
	}

	let lines = text.split("\n");
	let headApplied: number | undefined;
	let tailApplied: number | undefined;

	if (headLines !== undefined && headLines > 0 && lines.length > headLines) {
		lines = lines.slice(0, headLines);
		headApplied = headLines;
	}

	if (tailLines !== undefined && tailLines > 0 && lines.length > tailLines) {
		lines = lines.slice(-tailLines);
		tailApplied = tailLines;
	}

	return {
		text: lines.join("\n"),
		applied: headApplied !== undefined || tailApplied !== undefined,
		headApplied,
		tailApplied,
	};
}
