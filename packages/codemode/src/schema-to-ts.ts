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
		const desc = propSchema.description;
		if (desc) {
			lines.push(`  /** ${desc} */`);
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
 * Convert a JSON Schema (TypeBox) to a TypeScript type string.
 */
export function jsonSchemaToTypeScript(schema: unknown): string {
	return schemaToTs(schema as JSONSchema, false);
}
