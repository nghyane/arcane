import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@nghyane/arcane/config/settings";
import { createTools, type ToolSession } from "@nghyane/arcane/tools";
import { PythonTool } from "@nghyane/arcane/tools/python";
import { TempDir } from "@nghyane/arcane-utils";
import type { CodeAgentTool } from "../../src/tools/code-tool";

let previousSkipCheck: string | undefined;
let tempDir: TempDir;
beforeAll(() => {
	tempDir = TempDir.createSync("@arc-python-test-");
	previousSkipCheck = Bun.env.ARCANE_PYTHON_SKIP_CHECK;
	Bun.env.ARCANE_PYTHON_SKIP_CHECK = "1";
});

afterAll(() => {
	if (previousSkipCheck === undefined) {
		delete Bun.env.ARCANE_PYTHON_SKIP_CHECK;
		return;
	}
	Bun.env.ARCANE_PYTHON_SKIP_CHECK = previousSkipCheck;
	tempDir.removeSync();
});

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		...overrides,
	};
}

function createSettings(toolMode: "ipy-only" | "bash-only" | "both"): Settings {
	return Settings.isolated({
		"lsp.formatOnWrite": true,
		"bashInterceptor.enabled": true,
		"python.toolMode": toolMode,
	});
}

function getWrappedNames(tools: Awaited<ReturnType<typeof createTools>>): string[] {
	const codeTool = tools.find(t => t.name === "code") as CodeAgentTool | undefined;
	return codeTool ? [...codeTool.wrappedToolMap.keys()] : [];
}

describe("python tool schema", () => {
	it("exposes expected parameters", () => {
		const tool = new PythonTool(createSession());
		const schema = tool.parameters as {
			type: string;
			properties: Record<string, { type: string; description?: string }>;
			required?: string[];
		};

		expect(schema.type).toBe("object");
		expect(schema.properties.cells.type).toBe("array");
		expect(schema.properties.timeout.type).toBe("number");
		expect(schema.properties.cwd.type).toBe("string");
		expect(schema.properties.reset.type).toBe("boolean");
		expect(schema.required).toEqual(["cells"]);
	});
});

describe("python tool description", () => {
	it("has a static description", () => {
		const tool = new PythonTool(createSession());
		expect(tool.description).toBe("Execute Python code in a persistent kernel");
	});
});

describe("python tool exposure", () => {
	it("includes python only in ipy-only mode", async () => {
		const session = createSession({ settings: createSettings("ipy-only") });
		const tools = await createTools(session);
		const names = getWrappedNames(tools);
		expect(names).toContain("python");
		expect(names).not.toContain("bash");
	});

	it("includes bash only in bash-only mode", async () => {
		const session = createSession({ settings: createSettings("bash-only") });
		const tools = await createTools(session);
		const names = getWrappedNames(tools);
		expect(names).toContain("bash");
		expect(names).not.toContain("python");
	});

	it("includes bash and python in both mode", async () => {
		const session = createSession({ settings: createSettings("both") });
		const tools = await createTools(session);
		const names = getWrappedNames(tools);
		expect(names).toContain("bash");
		expect(names).toContain("python");
	});
});
