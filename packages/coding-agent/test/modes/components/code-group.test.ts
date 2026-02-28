import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@nghyane/arcane-tui";
import { CodeGroupComponent } from "../../../src/modes/components/code-group";
import { initTheme } from "../../../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function mockUI(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const WIDTH = 80;

function stripAnsi(str: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderPlain(group: CodeGroupComponent, width = WIDTH): string[] {
	return group.render(width).map(stripAnsi);
}

describe("CodeGroupComponent", () => {
	it("renders with intent header", () => {
		const group = new CodeGroupComponent(mockUI());
		group.setIntent("Running checks");
		const lines = renderPlain(group);
		expect(lines.some(l => l.includes("Running checks"))).toBe(true);
	});

	it("step group renders with intent header", () => {
		const group = new CodeGroupComponent(mockUI());
		group.startStep("step_1", "Reading files");
		const lines = renderPlain(group);
		expect(lines.some(l => l.includes("Reading files"))).toBe(true);
	});

	it("completed step collapses to summary with duration", () => {
		const group = new CodeGroupComponent(mockUI());
		group.startStep("step_1", "Reading files");
		group.endStep("step_1", 150);
		const lines = renderPlain(group);
		const stepLine = lines.find(l => l.includes("Reading files"));
		expect(stepLine).toBeDefined();
		expect(stepLine).toContain("150ms");
	});

	it("progress line updates in-place", () => {
		const group = new CodeGroupComponent(mockUI());
		group.startStep("step_1", "Processing");
		group.updateStepProgress("step_1", "file 1 of 3");
		let lines = renderPlain(group);
		expect(lines.some(l => l.includes("file 1 of 3"))).toBe(true);

		group.updateStepProgress("step_1", "file 2 of 3");
		lines = renderPlain(group);
		expect(lines.some(l => l.includes("file 2 of 3"))).toBe(true);
		expect(lines.some(l => l.includes("file 1 of 3"))).toBe(false);
	});

	it("progress clears when step ends", () => {
		const group = new CodeGroupComponent(mockUI());
		group.startStep("step_1", "Processing");
		group.updateStepProgress("step_1", "doing stuff");
		group.endStep("step_1", 100);
		const lines = renderPlain(group);
		expect(lines.some(l => l.includes("doing stuff"))).toBe(false);
	});

	it("parallel steps both visible", () => {
		const group = new CodeGroupComponent(mockUI());
		group.startStep("step_a", "Step A");
		group.startStep("step_b", "Step B");
		const lines = renderPlain(group);
		expect(lines.some(l => l.includes("Step A"))).toBe(true);
		expect(lines.some(l => l.includes("Step B"))).toBe(true);
	});

	it("ungrouped sub-tools render flat (no steps)", () => {
		const group = new CodeGroupComponent(mockUI());
		const lines = renderPlain(group);
		// Should render header at minimum
		expect(lines.length).toBeGreaterThan(0);
	});

	it("abort renders as info message", () => {
		const group = new CodeGroupComponent(mockUI());
		group.setAbortMessage("Nothing to do");
		const lines = renderPlain(group);
		expect(lines.some(l => l.includes("Nothing to do"))).toBe(true);
	});
});
