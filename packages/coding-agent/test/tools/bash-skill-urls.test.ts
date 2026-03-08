import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Skill } from "../../src/extensibility/skills";
import { expandInternalUrls } from "../../src/tools/bash-skill-urls";

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

function createSkill(name: string, baseDir: string): Skill {
	const resolvedBaseDir = path.resolve(baseDir);
	return {
		name,
		description: `${name} description`,
		filePath: path.join(resolvedBaseDir, "SKILL.md"),
		baseDir: resolvedBaseDir,
		source: "test",
	};
}

function createInternalRouter(resources: Record<string, { sourcePath?: string; error?: string }>): {
	canHandle: (input: string) => boolean;
	resolve: (
		input: string,
	) => Promise<{ url: string; content: string; contentType: "text/plain"; sourcePath?: string }>;
} {
	return {
		canHandle: input => /^(agent|artifact|plan|memory|rule):\/\//.test(input),
		resolve: async input => {
			const entry = resources[input];
			if (!entry) {
				throw new Error(`No mapping for ${input}`);
			}
			if (entry.error) {
				throw new Error(entry.error);
			}
			return {
				url: input,
				content: "",
				contentType: "text/plain",
				sourcePath: entry.sourcePath,
			};
		},
	};
}

describe("expandInternalUrls", () => {
	it("expands skill/agent/artifact/plan/memory/rule URLs in one command", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const router = createInternalRouter({
			"artifact://12": { sourcePath: "/tmp/artifacts/12.bash.log" },
			"agent://reviewer_0": { sourcePath: "/tmp/session/reviewer_0.md" },
			"plan://session/plan.md": { sourcePath: "/tmp/plans/session/plan.md" },
			"memory://root/memory_summary.md": { sourcePath: "/tmp/memories/memory_summary.md" },
			"rule://rs-no-unwrap": { sourcePath: "/tmp/rules/rs-no-unwrap.md" },
		});
		const command =
			"cat agent://reviewer_0 artifact://12 plan://session/plan.md memory://root/memory_summary.md rule://rs-no-unwrap skill://valid-skill/scripts/init.py";
		const expectedSkillPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills, internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/session/reviewer_0.md")} ${shellEscape("/tmp/artifacts/12.bash.log")} ${shellEscape("/tmp/plans/session/plan.md")} ${shellEscape("/tmp/memories/memory_summary.md")} ${shellEscape("/tmp/rules/rs-no-unwrap.md")} ${shellEscape(expectedSkillPath)}`,
		);
	});

	it("expands quoted non-skill URLs and shell-escapes quotes in paths", async () => {
		const router = createInternalRouter({
			"artifact://7": { sourcePath: "/tmp/artifacts/with'quote.log" },
		});
		await expect(expandInternalUrls('cat "artifact://7"', { skills: [], internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/with'quote.log")}`,
		);
	});

	it("expands agent:// URLs when router is available", async () => {
		const router = createInternalRouter({
			"agent://abc": { sourcePath: "/tmp/session/abc.md" },
		});
		await expect(expandInternalUrls("echo agent://abc", { skills: [], internalRouter: router })).resolves.toBe(
			`echo ${shellEscape("/tmp/session/abc.md")}`,
		);
	});

	it("throws when non-skill URL is used without an internal router", async () => {
		await expect(expandInternalUrls("cat artifact://1", { skills: [] })).rejects.toThrow(
			"Cannot resolve artifact:// URL in bash command",
		);
	});

	it("throws when internal router resolves URL without sourcePath", async () => {
		const router = createInternalRouter({
			"rule://my-rule": {},
		});
		await expect(expandInternalUrls("cat rule://my-rule", { skills: [], internalRouter: router })).rejects.toThrow(
			"rule:// URL resolved without a filesystem path",
		);
	});

	it("surfaces resolver errors with actionable context", async () => {
		const router = createInternalRouter({
			"memory://root/missing.md": { error: "Memory file not found" },
		});
		await expect(
			expandInternalUrls("cat memory://root/missing.md", { skills: [], internalRouter: router }),
		).rejects.toThrow("Failed to resolve memory:// URL in bash command");
	});
});
