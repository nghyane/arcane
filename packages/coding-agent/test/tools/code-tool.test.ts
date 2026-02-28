import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@nghyane/arcane-agent";
import type { TextContent } from "@nghyane/arcane-ai";
import { Type } from "@sinclair/typebox";
import { createCodeTool } from "../../src/tools/code-tool";

function makeTool(name: string, fn: (id: string, args: unknown) => Promise<AgentToolResult>): AgentTool {
	return {
		name,
		label: name,
		description: `Test tool: ${name}`,
		parameters: Type.Object({ value: Type.String() }),
		concurrency: "shared" as const,
		execute: fn,
	};
}

function simpleResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

function getText(result: AgentToolResult): string {
	return (result.content[0] as TextContent).text;
}

describe("createCodeTool", () => {
	it("returns a tool named 'code' with correct structure", () => {
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);

		expect(codeTool.name).toBe("code");
		expect(codeTool.description).toContain("echo");
		expect(codeTool.parameters).toBeDefined();
		expect(codeTool.wrappedToolMap.get("echo")).toBe(echo);
	});

	it("executes code and returns result", async () => {
		const echo = makeTool("echo", async (_id, args) => simpleResult(`got: ${(args as { value: string }).value}`));
		const { codeTool } = createCodeTool([echo]);

		const result = await codeTool.execute("call_1", {
			code: 'async () => { return await codemode.echo({ value: "hello" }); }',
		});
		expect(getText(result)).toContain("got: hello");
	});

	it("returns '(no output)' when code returns nothing", async () => {
		const noop = makeTool("noop", async () => simpleResult(""));
		const { codeTool } = createCodeTool([noop]);

		const result = await codeTool.execute("call_1", {
			code: "async () => {}",
		});
		expect(getText(result)).toBe("(no output)");
	});

	it("truncates results exceeding MAX_RESULT_LENGTH", async () => {
		const big = makeTool("big", async () => simpleResult("x".repeat(10000)));
		const { codeTool } = createCodeTool([big]);

		const result = await codeTool.execute("call_1", {
			code: 'async () => { return await codemode.big({ value: "a" }); }',
		});
		expect(getText(result)).toContain("chars truncated");
	});

	it("includes completed tool results on error recovery", async () => {
		const good = makeTool("good", async () => simpleResult("success"));
		const bad = makeTool("bad", async () => {
			throw new Error("boom");
		});
		const { codeTool } = createCodeTool([good, bad]);

		const result = await codeTool.execute("call_1", {
			code: `async () => {
				await codemode.good({ value: "a" });
				await codemode.bad({ value: "b" });
			}`,
		});
		const text = getText(result);
		expect(text).toContain("Error");
		expect(text).toContain("Completed before error");
		expect(text).toContain("good");
	});

	it("emits dispatch events with correct parentToolCallId", async () => {
		const events: { type: string; parentToolCallId?: string }[] = [];
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);

		const ctx = {
			emit: (event: Record<string, unknown>) => {
				events.push({
					type: event.type as string,
					parentToolCallId: event.parentToolCallId as string,
				});
			},
		};

		await codeTool.execute(
			"parent_123",
			{ code: 'async () => await codemode.echo({ value: "hi" })' },
			undefined,
			undefined,
			ctx as never,
		);

		const starts = events.filter(e => e.type === "tool_execution_start");
		const ends = events.filter(e => e.type === "tool_execution_end");
		expect(starts.length).toBe(1);
		expect(starts[0].parentToolCallId).toBe("parent_123");
		expect(ends.length).toBe(1);
		expect(ends[0].parentToolCallId).toBe("parent_123");
	});

	it("supports parallel execution via Promise.all", async () => {
		const timestamps: number[] = [];
		const delayed = makeTool("delayed", async () => {
			timestamps.push(Date.now());
			await Bun.sleep(50);
			return simpleResult("done");
		});
		const { codeTool } = createCodeTool([delayed]);

		await codeTool.execute("call_1", {
			code: `async () => {
				await Promise.all([
					codemode.delayed({ value: "a" }),
					codemode.delayed({ value: "b" }),
				]);
			}`,
		});
		expect(timestamps.length).toBe(2);
		expect(Math.abs(timestamps[0] - timestamps[1])).toBeLessThan(40);
	});

	it("step() groups sub-tool events under stepId", async () => {
		const events: Record<string, unknown>[] = [];
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);
		const ctx = { emit: (e: Record<string, unknown>) => events.push(e) };

		await codeTool.execute(
			"parent_1",
			{
				code: `async () => {
				await step("Reading files", async () => {
					await codemode.echo({ value: "a" });
				});
			}`,
			},
			undefined,
			undefined,
			ctx as never,
		);

		const stepStarts = events.filter(e => e.type === "step_start");
		const stepEnds = events.filter(e => e.type === "step_end");
		expect(stepStarts.length).toBe(1);
		expect(stepStarts[0].intent).toBe("Reading files");
		expect(stepEnds.length).toBe(1);
		expect(typeof stepEnds[0].durationMs).toBe("number");
		const toolStarts = events.filter(e => e.type === "tool_execution_start");
		expect(toolStarts.length).toBe(1);
		expect(toolStarts[0].stepId).toBe(stepStarts[0].stepId);
	});

	it("nested step() correctly restores parent", async () => {
		const events: Record<string, unknown>[] = [];
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);
		const ctx = { emit: (e: Record<string, unknown>) => events.push(e) };

		await codeTool.execute(
			"parent_1",
			{
				code: `async () => {
				await step("Outer", async () => {
					await codemode.echo({ value: "before" });
					await step("Inner", async () => {
						await codemode.echo({ value: "inside" });
					});
					await codemode.echo({ value: "after" });
				});
			}`,
			},
			undefined,
			undefined,
			ctx as never,
		);

		const stepStarts = events.filter(e => e.type === "step_start") as { stepId: string; intent: string }[];
		const outerStepId = stepStarts.find(s => s.intent === "Outer")!.stepId;
		const innerStepId = stepStarts.find(s => s.intent === "Inner")!.stepId;
		const toolStarts = events.filter(e => e.type === "tool_execution_start") as { stepId?: string }[];
		expect(toolStarts[0].stepId).toBe(outerStepId);
		expect(toolStarts[1].stepId).toBe(innerStepId);
		expect(toolStarts[2].stepId).toBe(outerStepId);
	});

	it("parallel step() — both active simultaneously", async () => {
		const events: Record<string, unknown>[] = [];
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);
		const ctx = { emit: (e: Record<string, unknown>) => events.push(e) };

		await codeTool.execute(
			"parent_1",
			{
				code: `async () => {
				await Promise.all([
					step("A", async () => await codemode.echo({ value: "a" })),
					step("B", async () => await codemode.echo({ value: "b" })),
				]);
			}`,
			},
			undefined,
			undefined,
			ctx as never,
		);

		const stepStarts = events.filter(e => e.type === "step_start") as { intent: string }[];
		expect(stepStarts.length).toBe(2);
		expect(stepStarts.map(s => s.intent).sort()).toEqual(["A", "B"]);
	});

	it("progress() emits event with current stepId", async () => {
		const events: Record<string, unknown>[] = [];
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);
		const ctx = { emit: (e: Record<string, unknown>) => events.push(e) };

		await codeTool.execute(
			"parent_1",
			{
				code: `async () => {
				await step("Work", async () => {
					progress("doing stuff");
					await codemode.echo({ value: "a" });
				});
			}`,
			},
			undefined,
			undefined,
			ctx as never,
		);

		const progressEvents = events.filter(e => e.type === "step_progress");
		expect(progressEvents.length).toBe(1);
		expect(progressEvents[0].message).toBe("doing stuff");
		const stepStart = events.find(e => e.type === "step_start") as { stepId: string };
		expect(progressEvents[0].stepId).toBe(stepStart.stepId);
	});

	it("abort() returns clean result without error classification", async () => {
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);

		const result = await codeTool.execute("call_1", {
			code: 'async () => { abort("nothing to do"); }',
		});
		const text = getText(result);
		expect(text).toContain("Aborted");
		expect(text).toContain("nothing to do");
		expect(text).not.toContain("Error");
	});

	it("abort() mid-step ends step cleanly", async () => {
		const events: Record<string, unknown>[] = [];
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);
		const ctx = { emit: (e: Record<string, unknown>) => events.push(e) };

		const result = await codeTool.execute(
			"parent_1",
			{
				code: `async () => {
				await step("Work", async () => {
					await codemode.echo({ value: "a" });
					abort("done early");
				});
			}`,
			},
			undefined,
			undefined,
			ctx as never,
		);

		expect(getText(result)).toContain("Aborted");
		const stepEnds = events.filter(e => e.type === "step_end");
		expect(stepEnds.length).toBe(1);
	});

	it("code without step/progress/abort works unchanged", async () => {
		const echo = makeTool("echo", async () => simpleResult("ok"));
		const { codeTool } = createCodeTool([echo]);

		const result = await codeTool.execute("call_1", {
			code: 'async () => { return await codemode.echo({ value: "hi" }); }',
		});
		expect(getText(result)).toContain("ok");
	});
});
