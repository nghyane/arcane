import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@nghyane/arcane/config/settings";
import * as pythonExecutor from "@nghyane/arcane/ipy/executor";
import type { ToolSession } from "@nghyane/arcane/tools";
import { PythonTool } from "@nghyane/arcane/tools/python";
import { TempDir } from "@nghyane/arcane-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => `${cwd}/session-file.jsonl`,
		settings: Settings.isolated({
			"lsp.formatOnWrite": true,
			"bashInterceptor.enabled": true,
			"python.toolMode": "ipy-only",
			"python.kernelMode": "per-call",
		}),
	};
}

describe("python tool execution", () => {
	it("passes kernel options from settings and args", async () => {
		const tempDir = TempDir.createSync("@python-tool-");
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
			displayOutputs: [],
			stdinRequested: false,
		});

		const tool = new PythonTool(createSession(tempDir.path()));
		const result = await tool.execute(
			"call-id",
			{ cells: [{ code: "print('hi')" }], timeout: 5, cwd: tempDir.path(), reset: true },
			undefined,
			undefined,
			undefined,
		);

		expect(executeSpy).toHaveBeenCalledWith(
			"print('hi')",
			expect.objectContaining({
				cwd: tempDir.path(),
				timeoutMs: 5000,
				sessionId: `session:${tempDir.path()}/session-file.jsonl:cwd:${tempDir.path()}`,
				kernelMode: "per-call",
				reset: true,
			}),
		);
		const text = result.content.find(item => item.type === "text")?.text;
		expect(text).toBe("ok");

		executeSpy.mockRestore();
		tempDir.removeSync();
	});
});
