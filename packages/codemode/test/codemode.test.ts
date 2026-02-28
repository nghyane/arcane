import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { execute } from "../src/executor";
import { normalizeCode } from "../src/normalize";
import { jsonSchemaToTypeScript } from "../src/schema-to-ts";
import { generateTypes, sanitizeToolName } from "../src/type-generator";

describe("normalizeCode", () => {
	test("empty string → throws", () => {
		expect(() => normalizeCode("")).toThrow("empty code");
	});

	test("whitespace → throws", () => {
		expect(() => normalizeCode("   \n\t  ")).toThrow("empty code");
	});

	test("already valid async arrow", () => {
		const code = "async () => { return 1; }";
		expect(normalizeCode(code)).toBe(code);
	});

	test("async arrow with params", () => {
		const code = "async (x) => x";
		expect(normalizeCode(code)).toBe(code);
	});

	test("bare expression → throws", () => {
		expect(() => normalizeCode('codemode.bash({ command: "ls" })')).toThrow("async arrow function");
	});

	test("multi-statement → throws", () => {
		expect(() => normalizeCode("const x = 1;\nreturn x;")).toThrow("async arrow function");
	});

	test("strips markdown js code fences", () => {
		const code = `\`\`\`js\nasync () => { return 1; }\n\`\`\``;
		expect(normalizeCode(code)).toBe("async () => { return 1; }");
	});

	test("strips markdown typescript code fences", () => {
		const code = `\`\`\`typescript\nasync () => { return 1; }\n\`\`\``;
		expect(normalizeCode(code)).toBe("async () => { return 1; }");
	});

	test("code inside fences but not async arrow → throws", () => {
		const code = `\`\`\`js\nconst x = 1;\n\`\`\``;
		expect(() => normalizeCode(code)).toThrow("async arrow function");
	});
});

describe("sanitizeToolName", () => {
	test("normal name unchanged", () => {
		expect(sanitizeToolName("bash")).toBe("bash");
	});

	test("hyphens replaced with underscores", () => {
		expect(sanitizeToolName("my-tool")).toBe("my_tool");
	});

	test("dots replaced with underscores", () => {
		expect(sanitizeToolName("mcp.read")).toBe("mcp_read");
	});

	test("prepends underscore if starts with digit", () => {
		expect(sanitizeToolName("123tool")).toBe("_123tool");
	});

	test("reserved word delete → delete_", () => {
		expect(sanitizeToolName("delete")).toBe("delete_");
	});

	test("reserved word class → class_", () => {
		expect(sanitizeToolName("class")).toBe("class_");
	});

	test("already valid camelCase unchanged", () => {
		expect(sanitizeToolName("myTool")).toBe("myTool");
	});

	test("special chars replaced", () => {
		expect(sanitizeToolName("tool@v2")).toBe("tool_v2");
	});
});

describe("generateTypes", () => {
	test("digit-prefixed tool produces valid type name", () => {
		const tools = [
			{
				name: "123tool",
				label: "Test",
				description: "A test tool",
				parameters: Type.Object({}),
				concurrency: "shared" as const,
				execute: async () => ({ content: [] }),
			},
		];
		const { declarations } = generateTypes(tools);
		// Simple empty-object type is inlined, not emitted as separate interface
		expect(declarations).not.toMatch(/^interface \d/m);
		expect(declarations).not.toMatch(/^type \d/m);
		// Method name should use sanitized _123tool
		expect(declarations).toContain("_123tool");
	});
});

describe("jsonSchemaToTypeScript", () => {
	test("string type", () => {
		expect(jsonSchemaToTypeScript({ type: "string" })).toBe("string");
	});

	test("number type", () => {
		expect(jsonSchemaToTypeScript({ type: "number" })).toBe("number");
	});

	test("integer type", () => {
		expect(jsonSchemaToTypeScript({ type: "integer" })).toBe("number");
	});

	test("boolean type", () => {
		expect(jsonSchemaToTypeScript({ type: "boolean" })).toBe("boolean");
	});

	test("null type", () => {
		expect(jsonSchemaToTypeScript({ type: "null" })).toBe("null");
	});

	test("array of strings", () => {
		expect(jsonSchemaToTypeScript({ type: "array", items: { type: "string" } })).toBe("string[]");
	});

	test("object with properties", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: { name: { type: "string" }, age: { type: "number" } },
			required: ["name"],
		});
		expect(result).toContain("name: string;");
		expect(result).toContain("age?: number;");
	});

	test("enum", () => {
		expect(jsonSchemaToTypeScript({ enum: ["a", "b", "c"] })).toBe('"a" | "b" | "c"');
	});

	test("const value", () => {
		expect(jsonSchemaToTypeScript({ const: "fixed" })).toBe('"fixed"');
		expect(jsonSchemaToTypeScript({ const: 42 })).toBe("42");
	});

	test("required vs optional properties", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: { req: { type: "string" }, opt: { type: "string" } },
			required: ["req"],
		});
		expect(result).toContain("req: string;");
		expect(result).toContain("opt?: string;");
	});

	test("nested object", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: { inner: { type: "boolean" } },
					required: ["inner"],
				},
			},
			required: ["nested"],
		});
		expect(result).toContain("nested:");
		expect(result).toContain("inner: boolean;");
	});

	test("record type (additionalProperties)", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			additionalProperties: { type: "string" },
		});
		expect(result).toBe("Record<string, string>");
	});

	test("union (anyOf)", () => {
		const result = jsonSchemaToTypeScript({
			anyOf: [{ type: "string" }, { type: "number" }],
		});
		expect(result).toBe("string | number");
	});

	test("string const with quotes is escaped", () => {
		const result = jsonSchemaToTypeScript({ const: 'say "hello"' });
		expect(result).toBe('"say \\"hello\\""');
	});

	test("unknown input", () => {
		expect(jsonSchemaToTypeScript(null)).toBe("unknown");
		expect(jsonSchemaToTypeScript({})).toBe("unknown");
	});
});

describe("execute", () => {
	test("simple code execution", async () => {
		const result = await execute("async () => { return 42; }", {});
		expect(result.result).toBe(42);
		expect(result.error).toBeUndefined();
	});

	test("console.log capture", async () => {
		const result = await execute('async () => { console.log("hello"); }', {});
		expect(result.logs).toContain("hello");
	});

	test("console.warn capture", async () => {
		const result = await execute('async () => { console.warn("oops"); }', {});
		expect(result.logs).toEqual(["[warn] oops"]);
	});

	test("tool dispatch via codemode proxy", async () => {
		const mockFn = async (args: Record<string, unknown>) => ({ echoed: args });
		const result = await execute("async () => { return await codemode.myTool({ x: 1 }); }", { myTool: mockFn });
		expect(result.result).toEqual({ echoed: { x: 1 } });
	});

	test("unknown tool throws error", async () => {
		const result = await execute("async () => { return await codemode.nope(); }", {});
		expect(result.error?.message).toContain('"nope" not found');
	});

	test("execution error is captured", async () => {
		const result = await execute('async () => { throw new Error("boom"); }', {});
		expect(result.error?.message).toBe("boom");
		expect(result.result).toBeUndefined();
	});

	test("timeout", async () => {
		const result = await execute(
			"async () => { await new Promise(r => setTimeout(r, 200)); }",
			{},
			{ timeoutMs: 50 },
		);
		expect(result.error?.message).toContain("timed out");
	});

	test("abort signal", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		const result = await execute(
			"async () => { await new Promise(r => setTimeout(r, 500)); }",
			{},
			{ signal: controller.signal },
		);
		expect(result.error?.message).toContain("aborted");
	});

	test("proxy handles symbol keys and 'then' safely", async () => {
		const result = await execute("async () => { const c = codemode; return typeof c.then; }", {});
		expect(result.result).toBe("undefined");
		expect(result.error).toBeUndefined();
	});

	test("shadowed globals", async () => {
		const result = await execute("async () => { return { proc: typeof process, bun: typeof Bun }; }", {});
		expect(result.result).toEqual({ proc: "undefined", bun: "undefined" });
	});
});

describe("normalizeCode edge cases", () => {
	test("bare code with return keyword → throws", () => {
		const code = 'const msg = "please return the value";\nmsg';
		expect(() => normalizeCode(code)).toThrow("async arrow function");
	});

	test("bare expression with semicolons in string → throws", () => {
		const code = 'codemode.bash({ command: "echo; echo" })';
		expect(() => normalizeCode(code)).toThrow("async arrow function");
	});

	test("tsx fenced code is properly stripped", () => {
		const code = "```tsx\nasync () => { return 1; }\n```";
		expect(normalizeCode(code)).toBe("async () => { return 1; }");
	});
});
