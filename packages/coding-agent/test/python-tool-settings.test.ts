import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SettingPath, Settings } from "@nghyane/arcane/config/settings";
import * as pythonExecutor from "@nghyane/arcane/ipy/executor";
import * as pythonKernel from "@nghyane/arcane/ipy/kernel";
import { createTools, type ToolSession } from "@nghyane/arcane/tools";
import { PythonTool } from "@nghyane/arcane/tools/python";
import { Snowflake } from "@nghyane/arcane-utils";

function createSession(
	cwd: string,
	sessionFile: string,
	overrides?: Partial<Record<SettingPath, unknown>>,
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "python.toolMode": "ipy-only", ...overrides }),
	};
}

describe("python tool settings", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `python-tool-settings-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("exposes python tool when kernel is available", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const sessionFile = path.join(testDir, "session.jsonl");
		const tools = await createTools(createSession(testDir, sessionFile), ["python"]);

		expect(tools.map(tool => tool.name).sort()).toEqual(["python"]);
	});

	it("falls back to bash when python is unavailable", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({
			ok: false,
			reason: "missing",
		});
		const sessionFile = path.join(testDir, "session.jsonl");
		const tools = await createTools(createSession(testDir, sessionFile), ["python"]);

		expect(tools.map(tool => tool.name).sort()).toEqual(["bash"]);
	});

	it("passes kernel mode from settings to executor", async () => {
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

		const sessionFile = path.join(testDir, "session.jsonl");
		const session = createSession(testDir, sessionFile, { "python.kernelMode": "per-call" });
		const pythonTool = new PythonTool(session);

		await pythonTool.execute("tool-call", { cells: [{ code: "print(1)" }] });

		expect(executeSpy).toHaveBeenCalledWith(
			"print(1)",
			expect.objectContaining({
				kernelMode: "per-call",
				sessionId: `session:${sessionFile}:cwd:${testDir}`,
			}),
		);
	});
});
