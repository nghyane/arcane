import { describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@nghyane/arcane/config/settings";
import { createTools, type ToolSession } from "@nghyane/arcane/tools";

Bun.env.ARCANE_PYTHON_SKIP_CHECK = "1";

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated({}),
		...overrides,
	};
}

function createSettingsWithOverrides(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	return Settings.isolated({
		"lsp.formatOnWrite": true,
		"bashInterceptor.enabled": true,
		...overrides,
	});
}

function getToolNames(tools: Awaited<ReturnType<typeof createTools>>): string[] {
	return tools.map(t => t.name);
}

describe("createTools", () => {
	it("returns all builtin tools directly", async () => {
		const session = createTestSession();
		const tools = await createTools(session);
		const names = getToolNames(tools);

		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).toContain("edit");
		expect(names).toContain("write");
		expect(names).toContain("grep");
		expect(names).toContain("find");
		expect(names).toContain("lsp");
		expect(names).toContain("notebook");
		expect(names).toContain("task");
		expect(names).toContain("todo_write");
		expect(names).toContain("fetch");
		expect(names).toContain("web_search");
	});

	it("includes bash and python when python mode is both", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"python.toolMode": "both",
				"python.kernelMode": "session",
			}),
		});
		const tools = await createTools(session);
		const names = getToolNames(tools);

		expect(names).toContain("bash");
		expect(names).toContain("python");
	});

	it("includes bash only when python mode is bash-only", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"python.toolMode": "bash-only",
				"python.kernelMode": "session",
			}),
		});
		const tools = await createTools(session);
		const names = getToolNames(tools);

		expect(names).toContain("bash");
		expect(names).not.toContain("python");
	});

	it("excludes lsp tool when session disables LSP", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session);
		const names = getToolNames(tools);

		expect(names).not.toContain("lsp");
	});

	it("excludes lsp tool when disabled", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session);
		const names = getToolNames(tools);

		expect(names).not.toContain("lsp");
	});

	it("respects requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["read", "write"]);
		const names = getToolNames(tools);

		expect(names).toContain("read");
		expect(names).toContain("write");
		expect(names).not.toContain("bash");
	});

	it("excludes ask tool when hasUI is false", async () => {
		const session = createTestSession({ hasUI: false });
		const tools = await createTools(session);
		const names = getToolNames(tools);

		expect(names).not.toContain("ask");
	});

	it("includes ask tool when hasUI is true", async () => {
		const session = createTestSession({ hasUI: true });
		const tools = await createTools(session);
		const names = getToolNames(tools);

		expect(names).toContain("ask");
	});
});
