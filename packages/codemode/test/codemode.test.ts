import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { createCodeTool } from "../src/engine";
import type { CodeModeToolEvent, DispatchFn } from "../src/event-bridge";
import { bridgeToolFunctions } from "../src/event-bridge";
import { execute } from "../src/executor";
import { normalizeCode } from "../src/normalize";
import { jsonSchemaToTypeScript } from "../src/schema-to-ts";
import { generateTypes, sanitizeToolName } from "../src/type-generator";

describe("normalizeCode", () => {
	test("empty string → async () => {}", () => {
		expect(normalizeCode("")).toBe("async () => {}");
	});

	test("whitespace → async () => {}", () => {
		expect(normalizeCode("   \n\t  ")).toBe("async () => {}");
	});

	test("already valid async arrow", () => {
		const code = "async () => { return 1; }";
		expect(normalizeCode(code)).toBe(code);
	});

	test("async arrow with params", () => {
		const code = "async (x) => x";
		expect(normalizeCode(code)).toBe(code);
	});

	test("single expression → wraps with return", () => {
		expect(normalizeCode('codemode.bash({ command: "ls" })')).toBe(
			'async () => {\nreturn (codemode.bash({ command: "ls" }));\n}',
		);
	});

	test("single expression with trailing semicolon → strips semicolon", () => {
		expect(normalizeCode('codemode.bash({ command: "ls" });')).toBe(
			'async () => {\nreturn (codemode.bash({ command: "ls" }));\n}',
		);
	});

	test("multi-statement with return → wraps as body", () => {
		const code = "const x = 1;\nreturn x;";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("multi-statement without return → auto-returns last expression", () => {
		const code = "const x = 1;\nx + 2";
		expect(normalizeCode(code)).toBe("async () => {\nconst x = 1;\nreturn (x + 2);\n}");
	});

	test("last line is const → no auto-return", () => {
		const code = "const a = 1;\nconst b = 2";
		const result = normalizeCode(code);
		expect(result).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is let → no auto-return", () => {
		const code = "const a = 1;\nlet b = 2";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is if → no auto-return", () => {
		const code = "const a = 1;\nif (a) {}";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is for → no auto-return", () => {
		const code = "const a = [];\nfor (const x of a) {}";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is while → no auto-return", () => {
		const code = "let i = 0;\nwhile (i < 10) { i++; }";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is throw → no auto-return", () => {
		const code = 'const x = 1;\nthrow new Error("fail")';
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is try → no auto-return", () => {
		const code = "const x = 1;\ntry { x; } catch {}";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is switch → no auto-return", () => {
		const code = "const x = 1;\nswitch (x) {}";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is do → no auto-return", () => {
		const code = "let i = 0;\ndo { i++; } while (i < 3)";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is block comment → no auto-return", () => {
		const code = "const x = 1;\n/* done */";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is line comment → no auto-return", () => {
		const code = "const x = 1;\n// done";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is { → no auto-return", () => {
		const code = "const x = 1;\n{";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("contains return keyword → treats as function body", () => {
		const code = "return 42;";
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("semicolons trigger multi-statement path", () => {
		const code = "const x = 1; x";
		const result = normalizeCode(code);
		expect(result).toContain("async () => {");
	});

	test("last line is closing brace → no auto-return", () => {
		const code = "if (true) {\n  doStuff();\n}";
		const result = normalizeCode(code);
		expect(result).toBe(`async () => {\n${code}\n}`);
		expect(result).not.toContain("return (})");
	});

	test("last line is }) → no auto-return", () => {
		const code = "arr.forEach(x => {\n  use(x);\n})";
		const result = normalizeCode(code);
		expect(result).toBe(`async () => {\n${code}\n}`);
	});

	test("last line is }); → no auto-return", () => {
		const code = "arr.forEach(x => {\n  use(x);\n});";
		const result = normalizeCode(code);
		expect(result).toBe(`async () => {\n${code}\n}`);
	});

	test("strips markdown js code fences", () => {
		const code = `\`\`\`js\nasync () => { return 1; }\n\`\`\``;
		expect(normalizeCode(code)).toBe("async () => { return 1; }");
	});

	test("strips markdown typescript code fences", () => {
		const code = `\`\`\`typescript\nconst x = 1;\nreturn x;\n\`\`\``;
		const result = normalizeCode(code);
		expect(result).toContain("const x = 1;");
		expect(result).toContain("return x;");
		expect(result).not.toContain("```");
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
		expect(declarations).not.toMatch(/^interface \d/m);
		expect(declarations).not.toMatch(/^type \d/m);
		expect(declarations).toContain("Tool123toolInput");
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
		expect(result.error).toContain('"nope" not found');
	});

	test("execution error is captured", async () => {
		const result = await execute('async () => { throw new Error("boom"); }', {});
		expect(result.error).toBe("boom");
		expect(result.result).toBeUndefined();
	});

	test("timeout", async () => {
		const result = await execute(
			"async () => { await new Promise(r => setTimeout(r, 200)); }",
			{},
			{ timeoutMs: 50 },
		);
		expect(result.error).toContain("timed out");
	});

	test("abort signal", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		const result = await execute(
			"async () => { await new Promise(r => setTimeout(r, 500)); }",
			{},
			{ signal: controller.signal },
		);
		expect(result.error).toContain("aborted");
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
	test("return inside a string does not trigger return detection", () => {
		const code = 'const msg = "please return the value";\nmsg';
		const result = normalizeCode(code);
		expect(result).toContain("return (msg)");
	});

	test("semicolons inside strings do not trigger multi-statement detection", () => {
		const code = 'codemode.bash({ command: "echo; echo" })';
		const result = normalizeCode(code);
		// Single expression — should be wrapped with return
		expect(result).toBe('async () => {\nreturn (codemode.bash({ command: "echo; echo" }));\n}');
	});

	test("tsx fenced code is properly stripped", () => {
		const code = "```tsx\nasync () => { return 1; }\n```";
		expect(normalizeCode(code)).toBe("async () => { return 1; }");
	});
});

describe("createCodeTool", () => {
	const mockTool = {
		name: "test_tool",
		label: "Test Tool",
		description: "A test tool",
		parameters: Type.Object({ query: Type.String() }),
		concurrency: "shared" as const,
		execute: async (_toolCallId: string, params: unknown) => ({
			content: [{ type: "text" as const, text: `result: ${(params as { query: string }).query}` }],
		}),
	};

	test("returns tool with correct name, description, and parameters", () => {
		const { codeTool } = createCodeTool([mockTool]);
		expect(codeTool.name).toBe("code");
		expect(codeTool.description).toContain("test_tool");
		expect(codeTool.parameters).toBeDefined();
	});

	test("EXCLUDED_TOOLS are filtered out", () => {
		const excludedTool = {
			name: "ask",
			label: "Ask",
			description: "Ask the user",
			parameters: Type.Object({}),
			concurrency: "shared" as const,
			execute: async () => ({ content: [] }),
		};
		const { codeTool, excludedTools } = createCodeTool([mockTool, excludedTool]);
		expect(excludedTools).toHaveLength(1);
		expect(excludedTools[0].name).toBe("ask");
		expect(codeTool.description).not.toContain("\nask(");
	});

	test("execute runs code and returns text result", async () => {
		const { codeTool } = createCodeTool([mockTool]);
		const result = await codeTool.execute.call(
			codeTool,
			"call-1",
			{ code: 'async () => { return await codemode.test_tool({ query: "hello" }); }' },
			new AbortController().signal,
		);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("result: hello");
	});

	test("result truncation at 4000 chars", async () => {
		const longTool = {
			name: "long_tool",
			label: "Long Tool",
			description: "Returns a long string",
			parameters: Type.Object({}),
			concurrency: "shared" as const,
			execute: async () => ({
				content: [{ type: "text" as const, text: "x".repeat(5000) }],
			}),
		};
		const { codeTool } = createCodeTool([longTool]);
		const result = await codeTool.execute.call(
			codeTool,
			"call-2",
			{ code: "async () => { return await codemode.long_tool({}); }" },
			new AbortController().signal,
		);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("truncated");
	});

	test("(no output) fallback when code returns undefined", async () => {
		const { codeTool } = createCodeTool([mockTool]);
		const result = await codeTool.execute.call(
			codeTool,
			"call-3",
			{ code: "async () => { }" },
			new AbortController().signal,
		);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("(no output)");
	});
});

describe("bridgeToolFunctions", () => {
	test("emits tool_start before execution and tool_done after", async () => {
		const events: CodeModeToolEvent[] = [];
		const fns: Record<string, DispatchFn> = {
			my_tool: async (_id, args) => `echoed: ${args.x}`,
		};
		const nameMap = new Map([["my_tool", "my-tool"]]);
		const bridged = bridgeToolFunctions(fns, nameMap, e => events.push(e));

		const result = await bridged.my_tool({ x: 42 });

		expect(result).toBe("echoed: 42");
		expect(events).toHaveLength(2);
		expect(events[0].type).toBe("tool_start");
		expect(events[0].toolName).toBe("my-tool");
		expect(events[0].args).toEqual({ x: 42 });
		expect(events[1].type).toBe("tool_done");
		expect(events[1].toolName).toBe("my-tool");
		expect(events[1].result).toBe("echoed: 42");
		expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	test("emits tool_error and re-throws on failure", async () => {
		const events: CodeModeToolEvent[] = [];
		const fns: Record<string, DispatchFn> = {
			bad_tool: async () => {
				throw new Error("fail");
			},
		};
		const nameMap = new Map([["bad_tool", "bad-tool"]]);
		const bridged = bridgeToolFunctions(fns, nameMap, e => events.push(e));

		await expect(bridged.bad_tool({})).rejects.toThrow("fail");

		expect(events).toHaveLength(2);
		expect(events[0].type).toBe("tool_start");
		expect(events[1].type).toBe("tool_error");
		expect(events[1].error).toBe("fail");
		expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	test("nameMap reverse mapping uses original name in events", async () => {
		const events: CodeModeToolEvent[] = [];
		const fns: Record<string, DispatchFn> = {
			mcp_read: async () => "data",
		};
		const nameMap = new Map([["mcp_read", "mcp.read"]]);
		const bridged = bridgeToolFunctions(fns, nameMap, e => events.push(e));

		await bridged.mcp_read({});

		expect(events[0].toolName).toBe("mcp.read");
		expect(events[1].toolName).toBe("mcp.read");
	});

	test("toolCallId is generated with expected format", async () => {
		const events: CodeModeToolEvent[] = [];
		const fns: Record<string, DispatchFn> = {
			my_tool: async () => "ok",
		};
		const nameMap = new Map([["my_tool", "my-tool"]]);
		const bridged = bridgeToolFunctions(fns, nameMap, e => events.push(e));

		await bridged.my_tool({});

		const id = events[0].toolCallId;
		expect(id).toMatch(/^codemode_my-tool_\d+_[a-z0-9]+$/);
		// Same ID across start and done events
		expect(events[0].toolCallId).toBe(events[1].toolCallId);
	});
});

describe("parallel execution", () => {
	test("supports parallel tool execution via Promise.all", async () => {
		const slowTool = {
			name: "slow_tool",
			label: "Slow Tool",
			description: "A slow tool",
			parameters: Type.Object({ id: Type.Number() }),
			concurrency: "shared" as const,
			execute: async (_toolCallId: string, params: unknown) => {
				await Bun.sleep(50);
				return {
					content: [{ type: "text" as const, text: `done: ${(params as { id: number }).id}` }],
				};
			},
		};
		const { codeTool } = createCodeTool([slowTool]);
		const start = performance.now();
		const result = await codeTool.execute.call(
			codeTool,
			"call-parallel",
			{
				code: [
					"async () => {",
					"  const [a, b] = await Promise.all([",
					"    codemode.slow_tool({ id: 1 }),",
					"    codemode.slow_tool({ id: 2 }),",
					"  ]);",
					"  return { a, b };",
					"}",
				].join("\n"),
			},
			new AbortController().signal,
		);
		const elapsed = performance.now() - start;
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("done: 1");
		expect(text).toContain("done: 2");
		// Parallel: should be closer to 50ms than 100ms
		expect(elapsed).toBeLessThan(200);
	});
});
