import { StringEnum } from "@nghyane/arcane-ai";
import { type Static, Type } from "@sinclair/typebox";

export const replaceEditSchema = Type.Object({
	path: Type.String({ description: "File path (relative or absolute)" }),
	old_text: Type.String({
		description: "Text to find (fuzzy whitespace matching enabled)",
	}),
	new_text: Type.String({ description: "Replacement text" }),
	all: Type.Optional(
		Type.Boolean({
			description: "Replace all occurrences (default: unique match required)",
		}),
	),
});

export const patchEditSchema = Type.Object({
	path: Type.String({ description: "File path" }),
	op: Type.Optional(
		StringEnum(["create", "delete", "update"], {
			description: "Operation (default: update)",
		}),
	),
	rename: Type.Optional(Type.String({ description: "New path for move" })),
	diff: Type.Optional(
		Type.String({
			description: "Diff hunks (update) or full content (create)",
		}),
	),
});

export type ReplaceParams = Static<typeof replaceEditSchema>;
export type PatchParams = Static<typeof patchEditSchema>;

/** Pattern matching hashline display format: `LINE#ID:CONTENT` */
const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*\d+#[0-9a-zA-Z]{1,16}:/;

/** Pattern matching a unified-diff `+` prefix (but not `++`) */
const DIFF_PLUS_RE = /^[+-](?![+-])/;

/**
 * Strip hashline display prefixes and diff `+` markers from replacement lines.
 *
 * Models frequently copy the `LINE#ID  ` prefix from read output into their
 * replacement content, or include unified-diff `+` prefixes. Both corrupt the
 * output file. This strips them heuristically before application.
 */
export function stripNewLinePrefixes(lines: string[]): string[] {
	// Detect whether the *majority* of non-empty lines carry a prefix —
	// if only one line out of many has a match it's likely real content.
	let hashPrefixCount = 0;
	let diffPlusCount = 0;
	let nonEmpty = 0;
	for (const l of lines) {
		if (l.length === 0) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
		if (DIFF_PLUS_RE.test(l)) diffPlusCount++;
	}
	if (nonEmpty === 0) return lines;

	const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5;
	const stripPlus = !stripHash && nonEmpty >= 2 && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;

	if (!stripHash && !stripPlus) return lines;

	return lines.map(l => {
		if (stripHash) return l.replace(HASHLINE_PREFIX_RE, "");
		if (stripPlus) return l.replace(DIFF_PLUS_RE, "");
		return l;
	});
}

const hashlineReplaceContentFormat = (kind: string) =>
	Type.Union([
		Type.Null(),
		Type.Array(Type.String(), { description: `${kind} lines` }),
		Type.String({ description: `${kind} line` }),
	]);

const hashlineInsertContentFormat = (kind: string) =>
	Type.Union([
		Type.Array(Type.String(), { description: `${kind} lines`, minItems: 1 }),
		Type.String({ description: `${kind} line`, minLength: 1 }),
	]);

const hashlineTagFormat = (what: string) =>
	Type.String({
		description: `Tag identifying the ${what} — format "N#XX" (e.g. "5#PM"), copied verbatim from read output`,
	});

export function hashlineParseContent(edit: string | string[] | null): string[] {
	if (edit === null) return [];
	if (Array.isArray(edit)) return edit;
	const lines = stripNewLinePrefixes(edit.split("\n"));
	if (lines.length === 0) return [];
	if (lines.length > 1 && lines[lines.length - 1].trim() === "") return lines.slice(0, -1);
	return lines;
}

export function hashlineParseContentString(edit: string | string[] | null): string {
	if (edit === null) return "";
	if (Array.isArray(edit)) return edit.join("\n");
	return edit;
}

const hashlineReplaceOpSchema = Type.Object(
	{
		op: Type.Literal("replace"),
		target: hashlineTagFormat("line to replace (or start of range)"),
		end: Type.Optional(hashlineTagFormat("last line of range")),
		content: hashlineReplaceContentFormat("Replacement"),
	},
	{ additionalProperties: false },
);

const hashlineInsertOpSchema = Type.Object(
	{
		op: Type.Literal("insert"),
		target: hashlineTagFormat("anchor line"),
		position: StringEnum(["before", "after"], { description: "Insert before or after the anchor" }),
		content: hashlineInsertContentFormat("Inserted"),
	},
	{ additionalProperties: false },
);

const hashlineEditSpecUnion = Type.Union([hashlineReplaceOpSchema, hashlineInsertOpSchema], {
	discriminator: { propertyName: "op" },
});

// AJV discriminator requires `oneOf`, but TypeBox emits `anyOf`.
// Swap to `oneOf` so AJV validates only the matching sub-schema.
export const hashlineEditSpecSchema = (() => {
	const { anyOf, ...rest } = hashlineEditSpecUnion;
	return { ...rest, oneOf: anyOf } as unknown as typeof hashlineEditSpecUnion;
})();

export const hashlineEditSchema = Type.Object(
	{
		path: Type.String({ description: "File path (relative or absolute)" }),
		edits: Type.Array(hashlineEditSpecSchema, {
			description: "Changes to apply to the file at `path`",
			minItems: 0,
		}),
		delete: Type.Optional(Type.Boolean({ description: "Delete the file when true" })),
		rename: Type.Optional(Type.String({ description: "New path if moving" })),
	},
	{ additionalProperties: false },
);

export type HashlineToolEdit = Static<typeof hashlineEditSpecSchema>;
export type HashlineParams = Static<typeof hashlineEditSchema>;

export type TInput = typeof replaceEditSchema | typeof patchEditSchema | typeof hashlineEditSchema;

export type EditMode = "replace" | "patch" | "hashline";

export const DEFAULT_EDIT_MODE: EditMode = "patch";

export function normalizeEditMode(mode?: string | null): EditMode | null {
	switch (mode) {
		case "replace":
			return "replace";
		case "patch":
			return "patch";
		case "hashline":
			return "hashline";
		default:
			return null;
	}
}
