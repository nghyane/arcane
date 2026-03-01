import { beforeAll, describe, expect, it } from "bun:test";
import { CodeGroupComponent } from "../../../src/modes/components/code-group";
import { initTheme } from "../../../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

const WIDTH = 80;

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderPlain(group: CodeGroupComponent, width = WIDTH): string[] {
	return group.render(width).map(stripAnsi);
}

describe("CodeGroupComponent", () => {
	it("renders no header when no steps (flat mode)", () => {
		const group = new CodeGroupComponent();
		const lines = renderPlain(group);
		expect(lines.some(l => l.includes("Running"))).toBe(false);
		expect(lines.some(l => l.includes("Done"))).toBe(false);
	});

	it("ungrouped sub-tools render flat without header", () => {
		const group = new CodeGroupComponent();
		const lines = renderPlain(group);
		// No "Running" or "Done" header in flat mode
		expect(lines.some(l => l.includes("Running"))).toBe(false);
	});

	it("abort renders as info message", () => {
		const group = new CodeGroupComponent();
		group.setAbortMessage("Nothing to do");
		const lines = renderPlain(group);
		expect(lines.some(l => l.includes("Nothing to do"))).toBe(true);
	});
});
