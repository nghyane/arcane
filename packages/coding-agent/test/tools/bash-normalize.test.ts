import { describe, expect, it } from "bun:test";
import { applyHeadTail } from "../../src/tools/bash-normalize";

describe("applyHeadTail", () => {
	const sampleText = "line1\nline2\nline3\nline4\nline5";

	it("returns original when no limits", () => {
		const result = applyHeadTail(sampleText);
		expect(result.text).toBe(sampleText);
		expect(result.applied).toBe(false);
	});

	it("applies head limit", () => {
		const result = applyHeadTail(sampleText, 2);
		expect(result.text).toBe("line1\nline2");
		expect(result.applied).toBe(true);
		expect(result.headApplied).toBe(2);
	});

	it("applies tail limit", () => {
		const result = applyHeadTail(sampleText, undefined, 2);
		expect(result.text).toBe("line4\nline5");
		expect(result.applied).toBe(true);
		expect(result.tailApplied).toBe(2);
	});

	it("applies head then tail", () => {
		const result = applyHeadTail(sampleText, 4, 2);
		// head=4 gives: line1\nline2\nline3\nline4
		// tail=2 of that gives: line3\nline4
		expect(result.text).toBe("line3\nline4");
		expect(result.applied).toBe(true);
		expect(result.headApplied).toBe(4);
		expect(result.tailApplied).toBe(2);
	});

	it("does not apply if text is shorter than limit", () => {
		const result = applyHeadTail(sampleText, 10);
		expect(result.text).toBe(sampleText);
		expect(result.applied).toBe(false);
	});

	it("handles empty text", () => {
		const result = applyHeadTail("", 5);
		expect(result.text).toBe("");
		expect(result.applied).toBe(false);
	});

	it("handles single line", () => {
		const result = applyHeadTail("single", 1);
		expect(result.text).toBe("single");
		expect(result.applied).toBe(false);
	});
});
