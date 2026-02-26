/**
 * Edit tool module.
 *
 * Supports three modes:
 * - Replace mode (default): oldText/newText replacement with fuzzy matching
 * - Patch mode: structured diff format with explicit operation type
 * - Hashline mode: line-addressed edits using content hashes for integrity
 *
 * The mode is determined by the `edit.mode` setting.
 */
// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

// Application
export { applyPatch, defaultFileSystem, previewPatch } from "./applicator";
// Diff generation
export {
	computeEditDiff,
	computeHashlineDiff,
	computePatchDiff,
	generateDiffString,
	generateUnifiedDiffString,
	replaceText,
} from "./diff";
// Edit tool
export { EditTool } from "./edit-tool";
// Fuzzy matching
export {
	DEFAULT_FUZZY_THRESHOLD,
	findContextLine,
	findMatch as findEditMatch,
	findMatch,
	seekSequence,
} from "./fuzzy";
// Hashline
export {
	applyHashlineEdits,
	computeLineHash,
	formatHashLines,
	HashlineMismatchError,
	parseTag,
	streamHashLinesFromLines,
	streamHashLinesFromUtf8,
	validateLineRef,
} from "./hashline";
// Normalization
export {
	adjustIndentation,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./normalize";
// Parsing
export {
	normalizeCreateContent,
	normalizeDiff,
	parseHunks as parseDiffHunks,
} from "./parser";
// Schemas & types
export {
	DEFAULT_EDIT_MODE,
	type EditMode,
	type HashlineParams,
	type HashlineToolEdit,
	normalizeEditMode,
	type PatchParams,
	type ReplaceParams,
} from "./schemas";
export type { EditRenderContext, EditToolDetails } from "./shared";
// Rendering
export { getLspBatchRequest } from "./shared";
export type {
	ApplyPatchOptions,
	ApplyPatchResult,
	ContextLineResult,
	DiffError,
	DiffError as EditDiffError,
	DiffHunk,
	DiffHunk as UpdateChunk,
	DiffHunk as UpdateFileChunk,
	DiffResult,
	DiffResult as EditDiffResult,
	FileChange,
	FileSystem,
	FuzzyMatch as EditMatch,
	FuzzyMatch,
	HashMismatch,
	MatchOutcome as EditMatchOutcome,
	MatchOutcome,
	Operation,
	PatchInput,
	SequenceSearchResult,
} from "./types";
// Types
// Legacy aliases for backwards compatibility
export { ApplyPatchError, EditMatchError, ParseError } from "./types";
