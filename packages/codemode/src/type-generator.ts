/**
 * Generate TypeScript declarations from an AgentTool registry.
 *
 * Produces a `declare const codemode: { ... }` block that the LLM
 * sees in the code tool's description, enabling typed orchestration.
 */

import type { AgentTool } from "@nghyane/arcane-agent";
import { jsonSchemaToTypeScript } from "./schema-to-ts";

const JS_RESERVED = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"let",
	"static",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"await",
	"async",
]);

/**
 * Sanitize a tool name into a valid JavaScript identifier.
 * - Replaces hyphens/dots/spaces with underscores
 * - Prepends underscore if starts with digit
 * - Appends underscore if reserved word
 */
export function sanitizeToolName(name: string): string {
	let safe = name.replace(/[^a-zA-Z0-9_$]/g, "_");
	if (/^\d/.test(safe)) safe = `_${safe}`;
	if (JS_RESERVED.has(safe)) safe = `${safe}_`;
	return safe;
}

/**
 * Convert a sanitized name to PascalCase for type names.
 * Filters empty segments to handle leading underscores (e.g., "_123tool").
 * Ensures result starts with a letter by prefixing "Tool" if needed.
 */
function toPascalCase(name: string): string {
	const result = name
		.split(/[_\s-]+/)
		.filter(s => s.length > 0)
		.map(s => s.charAt(0).toUpperCase() + s.slice(1))
		.join("");
	// If result starts with a digit, prefix with "Tool"
	if (/^\d/.test(result)) return `Tool${result}`;
	return result || "Unknown";
}

/**
 * Parse a tool's markdown description into summary (first paragraph) and guidance (rest).
 * Skips the H1 heading. Summary = first non-empty paragraph. Guidance = everything after.
 */
function parseToolDescription(description: string): { summary: string; guidance: string[] } {
	const lines = description.split("\n");
	const summaryLines: string[] = [];
	const guidanceLines: string[] = [];
	let pastHeading = false;
	let pastSummary = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!pastHeading) {
			if (trimmed.startsWith("# ")) {
				pastHeading = true;
				continue;
			}
			if (trimmed === "") continue;
			pastHeading = true;
		}
		if (!pastSummary) {
			if (summaryLines.length > 0 && (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("<"))) {
				pastSummary = true;
			} else if (trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("<")) {
				summaryLines.push(trimmed);
				continue;
			} else if (trimmed === "") {
				continue;
			} else {
				pastSummary = true;
			}
		}
		guidanceLines.push(trimmed);
	}

	// Trim leading/trailing blank lines from guidance
	while (guidanceLines.length > 0 && guidanceLines[0] === "") guidanceLines.shift();
	while (guidanceLines.length > 0 && guidanceLines[guidanceLines.length - 1] === "") guidanceLines.pop();

	return { summary: summaryLines.join(" "), guidance: guidanceLines };
}

interface GeneratedTypes {
	/** Full TypeScript declaration block */
	declarations: string;
	/** Map from sanitized name → original tool name */
	nameMap: Map<string, string>;
}

/**
 * Generate TypeScript type declarations for a set of tools.
 */
export function generateTypes(tools: AgentTool[]): GeneratedTypes {
	const nameMap = new Map<string, string>();
	const interfaceBlocks: string[] = [];
	const methodLines: string[] = [];

	for (const tool of tools) {
		const safeName = sanitizeToolName(tool.name);
		const existing = nameMap.get(safeName);
		if (existing && existing !== tool.name) {
			throw new Error(`Tool name collision: "${tool.name}" and "${existing}" both sanitize to "${safeName}"`);
		}
		const pascalName = toPascalCase(safeName);
		nameMap.set(safeName, tool.name);

		// Generate input type from tool parameters schema
		const inputTypeName = `${pascalName}Input`;
		const inputTs = jsonSchemaToTypeScript(tool.parameters);

		// Inline simple types directly into method signature to save tokens
		const lineCount = inputTs.split("\n").length;
		const isSimple = lineCount <= 5 && inputTs.length < 120;

		if (!isSimple) {
			if (inputTs.includes("\n")) {
				interfaceBlocks.push(`interface ${inputTypeName} ${inputTs}`);
			} else {
				interfaceBlocks.push(`type ${inputTypeName} = ${inputTs};`);
			}
		}

		// Build JSDoc from tool description — summary + guidance
		const docLines: string[] = [];
		if (tool.description) {
			const { summary, guidance } = parseToolDescription(tool.description);
			if (summary && guidance.length > 0) {
				docLines.push(`  /** ${summary}`);
				docLines.push(`  *`);
				for (const line of guidance) {
					docLines.push(line === "" ? `  *` : `  * ${line}`);
				}
				docLines.push(`  */`);
			} else if (summary) {
				docLines.push(`  /** ${summary} */`);
			}
		}

		const paramType = isSimple ? inputTs : inputTypeName;
		methodLines.push(...docLines);
		methodLines.push(`  ${safeName}: (input: ${paramType}) => Promise<unknown>;`);
	}

	const declarations = [
		...interfaceBlocks,
		"",
		"declare const codemode: {",
		...methodLines,
		"};",
		"",
		"/** Persistent key-value store shared across all code executions in this conversation. Use to cache results, track state, or pass data between turns. */",
		"declare const state: Map<string, unknown>;",
		"",
		"/** Cache-on-first-call helper. Returns cached value for `key` if it exists, otherwise calls `fn`, caches the result, and returns it. */",
		"declare const memo: <T = unknown>(key: string, fn: () => Promise<T>) => Promise<T>;",
	].join("\n");

	return { declarations, nameMap };
}
