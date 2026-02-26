import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@nghyane/arcane-agent";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	flushLspWritethroughBatch,
	type WritethroughCallback,
	writethroughNoop,
} from "../lsp";
import type { Theme } from "../modes/theme/theme";
import type { ToolSession } from "../tools";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { resolveToCwd } from "../tools/path-utils";
import { saveForUndo } from "../tools/undo-history";
import { applyPatch } from "./applicator";
import { generateDiffString, generateUnifiedDiffString, replaceText } from "./diff";
import { findMatch } from "./fuzzy";
import {
	applyHashlineEdits,
	computeLineHash,
	type HashlineEdit,
	type LineTag,
	parseTag,
	type ReplaceTextEdit,
} from "./hashline";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import { buildNormativeUpdateInput } from "./normative";
import {
	DEFAULT_EDIT_MODE,
	type EditMode,
	type HashlineParams,
	hashlineEditSchema,
	hashlineParseContent,
	hashlineParseContentString,
	normalizeEditMode,
	type PatchParams,
	patchEditSchema,
	type ReplaceParams,
	replaceEditSchema,
	type TInput,
} from "./schemas";
import { type EditToolDetails, editToolRenderer, getLspBatchRequest } from "./shared";
import type { FileSystem, Operation, PatchInput } from "./types";
import { EditMatchError } from "./types";

class LspFileSystem implements FileSystem {
	#lastDiagnostics: FileDiagnosticsResult | undefined;
	#fileCache: Record<string, Bun.BunFile> = {};

	constructor(
		private readonly writethrough: (
			dst: string,
			content: string,
			signal?: AbortSignal,
			file?: import("bun").BunFile,
			batch?: { id: string; flush: boolean },
		) => Promise<FileDiagnosticsResult | undefined>,
		private readonly signal?: AbortSignal,
		private readonly batchRequest?: { id: string; flush: boolean },
	) {}

	#getFile(path: string): Bun.BunFile {
		if (this.#fileCache[path]) {
			return this.#fileCache[path];
		}
		const file = Bun.file(path);
		this.#fileCache[path] = file;
		return file;
	}

	async exists(path: string): Promise<boolean> {
		return this.#getFile(path).exists();
	}

	async read(path: string): Promise<string> {
		return this.#getFile(path).text();
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const buffer = await this.#getFile(path).arrayBuffer();
		return new Uint8Array(buffer);
	}

	async write(path: string, content: string): Promise<void> {
		const file = this.#getFile(path);
		const result = await this.writethrough(path, content, this.signal, file, this.batchRequest);
		if (result) {
			this.#lastDiagnostics = result;
		}
	}

	async delete(path: string): Promise<void> {
		await this.#getFile(path).unlink();
	}

	async mkdir(path: string): Promise<void> {
		await fs.mkdir(path, { recursive: true });
	}

	getDiagnostics(): FileDiagnosticsResult | undefined {
		return this.#lastDiagnostics;
	}
}

function mergeDiagnosticsWithWarnings(
	diagnostics: FileDiagnosticsResult | undefined,
	warnings: string[],
): FileDiagnosticsResult | undefined {
	if (warnings.length === 0) return diagnostics;
	const warningMessages = warnings.map(warning => `patch: ${warning}`);
	if (!diagnostics) {
		return {
			server: "patch",
			messages: warningMessages,
			summary: `Patch warnings: ${warnings.length}`,
			errored: false,
		};
	}
	return {
		...diagnostics,
		messages: [...warningMessages, ...diagnostics.messages],
		summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
	};
}

export class EditTool implements AgentTool<TInput, any, Theme> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly nonAbortable = true;
	readonly concurrency = "exclusive";
	readonly mergeCallAndResult = editToolRenderer.mergeCallAndResult;
	readonly renderCall = editToolRenderer.renderCall as unknown as AgentTool<TInput, any, Theme>["renderCall"];
	readonly renderResult = editToolRenderer.renderResult as unknown as AgentTool<TInput, any, Theme>["renderResult"];

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode | null;

	constructor(private readonly session: ToolSession) {
		const {
			ARCANE_EDIT_FUZZY: editFuzzy = "auto",
			ARCANE_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			ARCANE_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		if (envEditVariant && envEditVariant !== "auto") {
			const editMode = normalizeEditMode(envEditVariant);
			if (!editMode) {
				throw new Error(`Invalid ARCANE_EDIT_VARIANT: ${envEditVariant}`);
			}
			this.#editMode = editMode;
		}

		switch (editFuzzy) {
			case "true":
			case "1":
				this.#allowFuzzy = true;
				break;
			case "false":
			case "0":
				this.#allowFuzzy = false;
				break;
			case "auto":
				this.#allowFuzzy = session.settings.get("edit.fuzzyMatch");
				break;
			default:
				throw new Error(`Invalid ARCANE_EDIT_FUZZY: ${editFuzzy}`);
		}
		switch (editFuzzyThreshold) {
			case "auto":
				this.#fuzzyThreshold = session.settings.get("edit.fuzzyThreshold");
				break;
			default:
				this.#fuzzyThreshold = parseFloat(editFuzzyThreshold);
				if (Number.isNaN(this.#fuzzyThreshold) || this.#fuzzyThreshold < 0 || this.#fuzzyThreshold > 1) {
					throw new Error(`Invalid ARCANE_EDIT_FUZZY_THRESHOLD: ${editFuzzyThreshold}`);
				}
				break;
		}

		const enableLsp = session.enableLsp ?? true;
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		this.#writethrough = enableLsp
			? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics })
			: writethroughNoop;
	}

	/**
	 * Determine edit mode dynamically based on current model.
	 * This is re-evaluated on each access so tool definitions stay current when model changes.
	 */
	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		const activeModel = this.session.getActiveModelString?.();
		const editVariant =
			this.session.settings.getEditVariantForModel(activeModel) ??
			normalizeEditMode(this.session.settings.get("edit.mode"));
		return editVariant ?? DEFAULT_EDIT_MODE;
	}

	description = "Apply edits to existing files (create, update, delete, rename)";

	/**
	 * Dynamic parameters schema based on current edit mode (which depends on current model).
	 */
	get parameters(): TInput {
		switch (this.mode) {
			case "patch":
				return patchEditSchema;
			case "hashline":
				return hashlineEditSchema;
			default:
				return replaceEditSchema;
		}
	}

	async execute(
		_toolCallId: string,
		params: ReplaceParams | PatchParams | HashlineParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		const batchRequest = getLspBatchRequest(context?.toolCall);

		// ─────────────────────────────────────────────────────────────────
		// Hashline mode execution
		// ─────────────────────────────────────────────────────────────────
		if (this.mode === "hashline") {
			const { path, edits, delete: deleteFile, rename } = params as HashlineParams;

			if (path.endsWith(".ipynb") && edits?.length > 0) {
				throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
			}

			const absolutePath = resolveToCwd(path, this.session.cwd);
			const resolvedRename = rename ? resolveToCwd(rename, this.session.cwd) : undefined;
			const file = Bun.file(absolutePath);

			if (deleteFile) {
				if (await file.exists()) {
					await file.unlink();
				}
				invalidateFsScanAfterDelete(absolutePath);
				return {
					content: [{ type: "text", text: `Deleted ${path}` }],
					details: {
						diff: "",
						op: "delete",
						meta: outputMeta().get(),
					},
				};
			}

			if (!(await file.exists())) {
				const content: string[] = [];
				for (const edit of edits) {
					switch (edit.op) {
						case "append": {
							if (edit.after) {
								throw new Error(`File not found: ${path}`);
							}
							content.push(...hashlineParseContent(edit.content));
							break;
						}
						case "prepend": {
							if (edit.before) {
								throw new Error(`File not found: ${path}`);
							}
							content.unshift(...hashlineParseContent(edit.content));
							break;
						}
						default: {
							throw new Error(`File not found: ${path}`);
						}
					}
				}
				await file.write(content.join("\n"));
				return {
					content: [{ type: "text", text: `Created ${path}` }],
					details: {
						diff: "",
						op: "create",
						meta: outputMeta().get(),
					},
				};
			}

			const anchorEdits: HashlineEdit[] = [];
			const replaceEdits: ReplaceTextEdit[] = [];
			for (const edit of edits) {
				switch (edit.op) {
					case "set": {
						const { tag, content } = edit;
						anchorEdits.push({
							op: "set",
							tag: parseTag(tag),
							content: hashlineParseContent(content),
						});
						break;
					}
					case "replace": {
						const { first, last, content } = edit;
						anchorEdits.push({
							op: "replace",
							first: parseTag(first),
							last: parseTag(last),
							content: hashlineParseContent(content),
						});
						break;
					}
					case "append": {
						const { after, content } = edit;
						anchorEdits.push({
							op: "append",
							...(after ? { after: parseTag(after) } : {}),
							content: hashlineParseContent(content),
						});
						break;
					}
					case "prepend": {
						const { before, content } = edit;
						anchorEdits.push({
							op: "prepend",
							...(before ? { before: parseTag(before) } : {}),
							content: hashlineParseContent(content),
						});
						break;
					}
					case "insert": {
						const { before, after, content } = edit;
						if (before && !after) {
							anchorEdits.push({
								op: "prepend",
								before: parseTag(before),
								content: hashlineParseContent(content),
							});
						} else if (after && !before) {
							anchorEdits.push({
								op: "append",
								after: parseTag(after),
								content: hashlineParseContent(content),
							});
						} else if (before && after) {
							anchorEdits.push({
								op: "insert",
								before: parseTag(before),
								after: parseTag(after),
								content: hashlineParseContent(content),
							});
						} else {
							throw new Error(`Insert must have both before and after tags.`);
						}
						break;
					}
					case "replaceText": {
						const { old_text, new_text, all } = edit;
						replaceEdits.push({
							op: "replaceText",
							old_text: old_text,
							new_text: hashlineParseContentString(new_text),
							all: all ?? false,
						});
						break;
					}
					default:
						throw new Error(`Invalid edit operation: ${JSON.stringify(edit)}`);
				}
			}

			const rawContent = await file.text();
			const { bom, text: content } = stripBom(rawContent);
			const originalEnding = detectLineEnding(content);
			const originalNormalized = normalizeToLF(content);
			let normalizedContent = originalNormalized;

			// Apply anchor-based edits first (set, set_range, insert)
			const anchorResult = applyHashlineEdits(normalizedContent, anchorEdits);
			normalizedContent = anchorResult.content;

			// Apply content-replace edits (substr-style fuzzy replace)
			for (const r of replaceEdits) {
				if (r.old_text.length === 0) {
					throw new Error("old_text must not be empty.");
				}
				const rep = replaceText(normalizedContent, r.old_text, r.new_text, {
					fuzzy: this.#allowFuzzy,
					all: r.all ?? false,
					threshold: this.#fuzzyThreshold,
				});
				normalizedContent = rep.content;
			}

			const result = {
				content: normalizedContent,
				firstChangedLine: anchorResult.firstChangedLine,
				warnings: anchorResult.warnings,
				noopEdits: anchorResult.noopEdits,
			};
			if (originalNormalized === result.content && !rename) {
				let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
				if (result.noopEdits && result.noopEdits.length > 0) {
					const details = result.noopEdits
						.map(
							e =>
								`Edit ${e.editIndex}: replacement for ${e.loc} is identical to current content:\n  ${e.loc}| ${e.currentContent}`,
						)
						.join("\n");
					diagnostic += `\n${details}`;
					diagnostic +=
						"\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
				} else {
					// Edits were not literally identical but heuristics normalized them back
					const lines = result.content.split("\n");
					const targetLines: string[] = [];
					const refs: LineTag[] = [];
					for (const edit of anchorEdits) {
						refs.length = 0;
						switch (edit.op) {
							case "set":
								refs.push(edit.tag);
								break;
							case "replace":
								refs.push(edit.first, edit.last);
								break;
							case "append":
								if (edit.after) refs.push(edit.after);
								break;
							case "prepend":
								if (edit.before) refs.push(edit.before);
								break;
							case "insert":
								refs.push(edit.after, edit.before);
								break;
							default:
								break;
						}

						for (const ref of refs) {
							try {
								if (ref.line >= 1 && ref.line <= lines.length) {
									const lineContent = lines[ref.line - 1];
									const hash = computeLineHash(ref.line, lineContent);
									targetLines.push(`${ref.line}#${hash}:${lineContent}`);
								}
							} catch {
								/* skip malformed refs */
							}
						}
					}
					if (targetLines.length > 0) {
						const preview = [...new Set(targetLines)].slice(0, 5).join("\n");
						diagnostic += `\nThe file currently contains these lines:\n${preview}\nYour edits were normalized back to the original content (whitespace-only differences are preserved as-is). Ensure your replacement changes actual code, not just formatting.`;
					}
				}
				throw new Error(diagnostic);
			}

			const finalContent = bom + restoreLineEndings(result.content, originalEnding);
			const writePath = resolvedRename ?? absolutePath;
			saveForUndo(absolutePath, rawContent);
			const diagnostics = await this.#writethrough(
				writePath,
				finalContent,
				signal,
				Bun.file(writePath),
				batchRequest,
			);
			if (resolvedRename && resolvedRename !== absolutePath) {
				await file.unlink();
				invalidateFsScanAfterRename(absolutePath, resolvedRename);
			} else {
				invalidateFsScanAfterWrite(absolutePath);
			}
			const diffResult = generateDiffString(originalNormalized, result.content);

			const normative = buildNormativeUpdateInput({
				path,
				...(rename ? { rename } : {}),
				oldContent: rawContent,
				newContent: finalContent,
			});

			const meta = outputMeta()
				.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
				.get();

			const resultText = rename ? `Updated and moved ${path} to ${rename}` : `Updated ${path}`;
			return {
				content: [
					{
						type: "text",
						text: `${resultText}${result.warnings?.length ? `\n\nWarnings:\n${result.warnings.join("\n")}` : ""}`,
					},
				],
				details: {
					diff: diffResult.diff,
					firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
					diagnostics,
					op: "update",
					rename,
					meta,
				},
				$normative: normative,
			};
		}

		// ─────────────────────────────────────────────────────────────────
		// Patch mode execution
		// ─────────────────────────────────────────────────────────────────
		if (this.mode === "patch") {
			const { path, op: rawOp, rename, diff } = params as PatchParams;

			// Normalize unrecognized operations to "update"
			const op: Operation = rawOp === "create" || rawOp === "delete" ? rawOp : "update";

			const resolvedPath = resolveToCwd(path, this.session.cwd);
			const resolvedRename = rename ? resolveToCwd(rename, this.session.cwd) : undefined;

			if (path.endsWith(".ipynb")) {
				throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
			}
			if (rename?.endsWith(".ipynb")) {
				throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
			}

			const input: PatchInput = {
				path: resolvedPath,
				op,
				rename: resolvedRename,
				diff,
			};
			const fs = new LspFileSystem(this.#writethrough, signal, batchRequest);
			const result = await applyPatch(input, {
				cwd: this.session.cwd,
				fs,
				fuzzyThreshold: this.#fuzzyThreshold,
				allowFuzzy: this.#allowFuzzy,
			});
			if (result.change.oldContent !== undefined) {
				saveForUndo(resolvedPath, result.change.oldContent);
			}
			if (resolvedRename) {
				invalidateFsScanAfterRename(resolvedPath, resolvedRename);
			} else if (result.change.type === "delete") {
				invalidateFsScanAfterDelete(resolvedPath);
			} else {
				invalidateFsScanAfterWrite(resolvedPath);
			}
			const effRename = result.change.newPath ? rename : undefined;

			// Generate diff for display
			let diffResult = {
				diff: "",
				firstChangedLine: undefined as number | undefined,
			};
			if (result.change.type === "update" && result.change.oldContent && result.change.newContent) {
				const normalizedOld = normalizeToLF(stripBom(result.change.oldContent).text);
				const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text);
				diffResult = generateUnifiedDiffString(normalizedOld, normalizedNew);
			}

			let resultText: string;
			switch (result.change.type) {
				case "create":
					resultText = `Created ${path}`;
					break;
				case "delete":
					resultText = `Deleted ${path}`;
					break;
				case "update":
					resultText = effRename ? `Updated and moved ${path} to ${effRename}` : `Updated ${path}`;
					break;
			}

			let diagnostics = fs.getDiagnostics();
			if (op === "delete" && batchRequest?.flush) {
				const flushedDiagnostics = await flushLspWritethroughBatch(batchRequest.id, this.session.cwd, signal);
				diagnostics ??= flushedDiagnostics;
			}
			const patchWarnings = result.warnings ?? [];
			const mergedDiagnostics = mergeDiagnosticsWithWarnings(diagnostics, patchWarnings);

			const meta = outputMeta()
				.diagnostics(mergedDiagnostics?.summary ?? "", mergedDiagnostics?.messages ?? [])
				.get();

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					diff: diffResult.diff,
					firstChangedLine: diffResult.firstChangedLine,
					diagnostics: mergedDiagnostics,
					op,
					rename: effRename,
					meta,
				},
			};
		}

		// ─────────────────────────────────────────────────────────────────
		// Replace mode execution
		// ─────────────────────────────────────────────────────────────────
		const { path, old_text, new_text, all } = params as ReplaceParams;

		if (path.endsWith(".ipynb")) {
			throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
		}

		if (old_text.length === 0) {
			throw new Error("old_text must not be empty.");
		}

		const absolutePath = resolveToCwd(path, this.session.cwd);
		const file = Bun.file(absolutePath);

		if (!(await file.exists())) {
			throw new Error(`File not found: ${path}`);
		}

		const rawContent = await file.text();
		const { bom, text: content } = stripBom(rawContent);
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);
		const normalizedOldText = normalizeToLF(old_text);
		const normalizedNewText = normalizeToLF(new_text);

		const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
			fuzzy: this.#allowFuzzy,
			all: all ?? false,
			threshold: this.#fuzzyThreshold,
		});

		if (result.count === 0) {
			// Get error details
			const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
				allowFuzzy: this.#allowFuzzy,
				threshold: this.#fuzzyThreshold,
			});

			if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
				const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
				const moreMsg = matchOutcome.occurrences > 5 ? ` (showing first 5 of ${matchOutcome.occurrences})` : "";
				throw new Error(
					`Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\n` +
						`Add more context lines to disambiguate.`,
				);
			}

			throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
				allowFuzzy: this.#allowFuzzy,
				threshold: this.#fuzzyThreshold,
				fuzzyMatches: matchOutcome.fuzzyMatches,
			});
		}

		if (normalizedContent === result.content) {
			throw new Error(
				`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
			);
		}

		const finalContent = bom + restoreLineEndings(result.content, originalEnding);
		saveForUndo(absolutePath, rawContent);
		const diagnostics = await this.#writethrough(absolutePath, finalContent, signal, file, batchRequest);
		invalidateFsScanAfterWrite(absolutePath);
		const diffResult = generateDiffString(normalizedContent, result.content);

		const resultText =
			result.count > 1
				? `Successfully replaced ${result.count} occurrences in ${path}.`
				: `Successfully replaced text in ${path}.`;

		const meta = outputMeta()
			.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
			.get();

		return {
			content: [{ type: "text", text: resultText }],
			details: {
				diff: diffResult.diff,
				firstChangedLine: diffResult.firstChangedLine,
				diagnostics,
				meta,
			},
		};
	}
}
