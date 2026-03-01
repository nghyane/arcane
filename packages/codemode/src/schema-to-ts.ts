/**
 * Convert JSON Schema (TypeBox at runtime) to TypeScript type declarations.
 *
 * TypeBox schemas are valid JSON Schema objects at runtime. This module
 * converts them into human-readable TypeScript interfaces for injection
 * into the Code Mode tool description, so the LLM can write typed code.
 */

interface JSONSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	items?: JSONSchema;
	enum?: (string | number | boolean)[];
	const?: unknown;
	anyOf?: JSONSchema[];
	oneOf?: JSONSchema[];
	allOf?: JSONSchema[];
	$ref?: string;
	additionalProperties?: boolean | JSONSchema;
	default?: unknown;
	[key: string]: unknown;
}

function isValidIdentifier(name: string): boolean {
	return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

function safePropName(name: string): string {
	return isValidIdentifier(name) ? name : JSON.stringify(name);
}

function schemaToTs(schema: JSONSchema, inline = false): string {
	if (!schema || typeof schema !== "object") return "unknown";

	// Literal / const
	if (schema.const !== undefined) {
		return typeof schema.const === "string" ? JSON.stringify(schema.const) : String(schema.const);
	}

	// Enum
	if (schema.enum) {
		return schema.enum.map(v => (typeof v === "string" ? JSON.stringify(v) : String(v))).join(" | ");
	}

	// Union types (anyOf / oneOf)
	const unionSchemas = schema.anyOf ?? schema.oneOf;
	if (unionSchemas) {
		const variants = unionSchemas.map(s => schemaToTs(s, true));
		return variants.join(" | ");
	}

	// Intersection (allOf)
	if (schema.allOf) {
		const parts = schema.allOf.map(s => schemaToTs(s, true));
		return parts.join(" & ");
	}

	// Primitive types
	if (Array.isArray(schema.type)) {
		const types = schema.type.map((t: string) => {
			switch (t) {
				case "string":
					return "string";
				case "number":
				case "integer":
					return "number";
				case "boolean":
					return "boolean";
				case "null":
					return "null";
				case "object":
					return "Record<string, unknown>";
				case "array":
					return "unknown[]";
				default:
					return "unknown";
			}
		});
		return types.join(" | ");
	}
	const type = schema.type;
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array": {
			if (schema.items) {
				const itemType = schemaToTs(schema.items, true);
				return itemType.includes("|") || itemType.includes("&") ? `Array<${itemType}>` : `${itemType}[]`;
			}
			return "unknown[]";
		}
		case "object":
			break;
		default:
			if (!schema.properties && !schema.additionalProperties) {
				return "unknown";
			}
	}

	// Object type
	const props = schema.properties;
	if (!props && schema.additionalProperties) {
		const valType =
			typeof schema.additionalProperties === "object" ? schemaToTs(schema.additionalProperties, true) : "unknown";
		return `Record<string, ${valType}>`;
	}
	if (!props) return "unknown";

	const required = new Set(schema.required ?? []);
	const lines: string[] = ["{"];
	for (const [key, propSchema] of Object.entries(props)) {
		const propType = schemaToTs(propSchema, true);
		const opt = required.has(key) ? "" : "?";
		const hint = buildPropertyHint(key, propSchema);
		if (hint) {
			lines.push(`  /** ${hint} */`);
		}
		lines.push(`  ${safePropName(key)}${opt}: ${propType};`);
	}
	lines.push("}");

	// Compact single-line for small objects when inline
	if (inline && lines.length <= 5) {
		const inner = lines
			.slice(1, -1)
			.map(l => l.trim())
			.filter(l => !l.startsWith("/**"));
		if (inner.join(" ").length < 60) {
			return `{ ${inner.join(" ")} }`;
		}
	}

	return lines.join("\n");
}

/**
 * Build a concise property hint combining description and constraints.
 */
function buildPropertyHint(propName: string, schema: JSONSchema): string | null {
	const parts: string[] = [];
	const desc = schema.description;
	if (desc && !isRedundantDescription(propName, desc)) {
		parts.push(desc);
	}
	const constraints = extractConstraints(schema);
	if (constraints) {
		parts.push(constraints);
	}
	return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Extract numeric/string/array constraints as a parenthetical hint.
 */
function extractConstraints(schema: JSONSchema): string | null {
	const hints: string[] = [];
	if (schema.minimum !== undefined) hints.push(`min: ${schema.minimum}`);
	if (schema.maximum !== undefined) hints.push(`max: ${schema.maximum}`);
	if (schema.exclusiveMinimum !== undefined) hints.push(`> ${schema.exclusiveMinimum}`);
	if (schema.exclusiveMaximum !== undefined) hints.push(`< ${schema.exclusiveMaximum}`);
	if (schema.minLength !== undefined && Number(schema.minLength) > 0) hints.push("non-empty");
	if (schema.maxLength !== undefined) hints.push(`max length: ${schema.maxLength}`);
	if (schema.pattern) hints.push(`pattern: ${schema.pattern}`);
	if (schema.minItems !== undefined && Number(schema.minItems) > 0) hints.push("non-empty");
	if (schema.maxItems !== undefined) hints.push(`max items: ${schema.maxItems}`);
	// Check union members for shared constraints
	const unionSchemas = schema.anyOf ?? schema.oneOf;
	if (unionSchemas && hints.length === 0) {
		const allNonEmpty = unionSchemas.every(
			s =>
				(s.minItems !== undefined && Number(s.minItems) > 0) ||
				(s.minLength !== undefined && Number(s.minLength) > 0),
		);
		if (allNonEmpty && unionSchemas.length > 0) hints.push("non-empty");
	}
	if (hints.length === 0) return null;
	return `(${[...new Set(hints)].join(", ")})`;
}

/**
 * Check if a property description is redundant given the property name.
 */
function isRedundantDescription(propName: string, desc: string): boolean {
	const lower = desc.toLowerCase();
	if (/\bdefault[s:]?\b/.test(lower)) return false;
	if (/\be\.g\./.test(lower)) return false;
	if (/\bformat\b/.test(lower)) return false;
	if (/\bmust\b/.test(lower)) return false;
	if (/\(/.test(desc)) return false;
	const normalized = lower.replace(/[^a-z]/g, "");
	const nameNorm = propName.toLowerCase().replace(/[^a-z]/g, "");
	if (normalized.includes(nameNorm) && desc.length < nameNorm.length + 20) return true;
	return false;
}
export function jsonSchemaToTypeScript(schema: unknown): string {
	return schemaToTs(schema as JSONSchema, false);
}
