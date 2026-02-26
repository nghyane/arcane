import { describe, expect, it, vi } from "bun:test";
import { type SettingPath, Settings } from "@nghyane/arcane/config/settings";
import * as pythonKernelModule from "@nghyane/arcane/ipy/kernel";
import { createTools, type ToolSession } from "@nghyane/arcane/tools";

import type { CodeAgentTool } from "@nghyane/arcane-codemode";

function getWrappedNames(tools: Awaited<ReturnType<typeof createTools>>): string[] {
	const codeTool = tools.find(t => t.name === "code") as CodeAgentTool | undefined;
	return codeTool ? [...codeTool.wrappedToolMap.keys()] : [];
}

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

describe("createTools python fallback", () => {
	it("falls back to bash-only when kernel unavailable", async () => {
		const availabilitySpy = vi
			.spyOn(pythonKernelModule, "checkPythonKernelAvailability")
			.mockResolvedValue({ ok: false, reason: "unavailable" });

		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"python.toolMode": "ipy-only",
				"python.kernelMode": "session",
			}),
		});

		const tools = await createTools(session, ["python"]);
		const names = getWrappedNames(tools).sort();

		expect(names).toEqual(["bash"]);

		availabilitySpy.mockRestore();
	});

	it("keeps bash when python mode is both but unavailable", async () => {
		const availabilitySpy = vi
			.spyOn(pythonKernelModule, "checkPythonKernelAvailability")
			.mockResolvedValue({ ok: false, reason: "unavailable" });

		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"python.toolMode": "both",
				"python.kernelMode": "session",
			}),
		});

		const tools = await createTools(session);
		const names = getWrappedNames(tools);

		expect(names).toContain("bash");
		expect(names).not.toContain("python");

		availabilitySpy.mockRestore();
	});
});
