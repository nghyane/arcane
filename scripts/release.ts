#!/usr/bin/env bun
/**
 * Zero-arg release script for arcane monorepo.
 *
 * Detects changed packages since their last release, bumps patch version,
 * updates CHANGELOGs, commits, tags per-package, and pushes.
 *
 * Usage:
 *   bun scripts/release.ts              # auto-detect + patch bump
 *   bun scripts/release.ts minor        # auto-detect + minor bump
 *   bun scripts/release.ts major        # auto-detect + major bump
 */

import { $, Glob } from "bun";
import * as path from "node:path";
import { detectChangedPackages } from "./detect-changes.ts";

type BumpType = "patch" | "minor" | "major";

const cargoTomlGlob = new Glob("crates/*/Cargo.toml");

function parseVersion(v: string): [number, number, number] {
	const match = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) throw new Error(`Invalid version: ${v}`);
	return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}

function bumpVersion(version: string, bump: BumpType): string {
	const [major, minor, patch] = parseVersion(version);
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

function hasUnreleasedContent(content: string): boolean {
	const unreleasedMatch = content.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);
	if (!unreleasedMatch) return false;
	return unreleasedMatch[1].trim().length > 0;
}

function removeEmptyVersionEntries(content: string): string {
	return content.replace(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
}

async function updateChangelog(pkgDir: string, version: string): Promise<void> {
	const changelogPath = path.join(pkgDir, "CHANGELOG.md");
	const file = Bun.file(changelogPath);
	try {
		let content = await file.text();
		if (!content.includes("## [Unreleased]")) return;

		const date = new Date().toISOString().split("T")[0];
		if (hasUnreleasedContent(content)) {
			content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
			content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
		}
		content = removeEmptyVersionEntries(content);
		await Bun.write(changelogPath, content);
		console.log(`  Updated ${changelogPath}`);
	} catch {
		// No changelog — that's fine
	}
}

async function updateRustVersionIfNeeded(version: string): Promise<void> {
	// Update workspace version in root Cargo.toml
	const cargoToml = await Bun.file("Cargo.toml").text();
	const currentMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (!currentMatch) return;

	if (currentMatch[1] !== version) {
		await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`.quiet();
		console.log(`  Updated Cargo.toml workspace version to ${version}`);
	}
}

async function main(): Promise<void> {
	console.log("\n=== Arcane Release ===\n");

	// Parse bump type
	const bumpArg = process.argv[2] as BumpType | undefined;
	const bump: BumpType = bumpArg && ["patch", "minor", "major"].includes(bumpArg)
		? bumpArg
		: "patch";

	// Pre-flight checks
	console.log("Pre-flight checks...");
	const branch = (await $`git branch --show-current`.text()).trim();
	if (branch !== "main") {
		console.error(`Error: Must be on main branch (currently on '${branch}')`);
		process.exit(1);
	}
	console.log("  On main branch");

	const status = (await $`git status --porcelain`.text()).trim();
	if (status) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean\n");

	// Detect changed packages
	console.log("Detecting changed packages...");
	const changedPackages = await detectChangedPackages();

	if (changedPackages.length === 0) {
		console.log("No packages changed since last release. Nothing to do.");
		process.exit(0);
	}

	for (const pkg of changedPackages) {
		console.log(`  ${pkg.name} (${pkg.dir})`);
	}
	console.log();

	// Bump versions
	console.log(`Bumping versions (${bump})...`);
	const tags: string[] = [];
	let highestNewVersion = "0.0.0";

	for (const pkg of changedPackages) {
		const newVersion = bumpVersion(pkg.version, bump);
		const pkgJsonPath = path.join(pkg.dir, "package.json");

		// Read, modify, write JSON properly instead of regex substitution
		const pkgJson = await Bun.file(pkgJsonPath).json();
		pkgJson.version = newVersion;

		// Update inter-package dependency versions
		for (const changed of changedPackages) {
			const depNewVersion = bumpVersion(changed.version, bump);
			if (pkgJson.dependencies?.[changed.name]) {
				pkgJson.dependencies[changed.name] = `^${depNewVersion}`;
			}
			if (pkgJson.devDependencies?.[changed.name]) {
				pkgJson.devDependencies[changed.name] = `^${depNewVersion}`;
			}
		}

		await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, "\t") + "\n");

		console.log(`  ${pkg.name}: ${pkg.version} -> ${newVersion}`);
		tags.push(`${pkg.name}@${newVersion}`);

		if (parseVersion(newVersion) > parseVersion(highestNewVersion)) {
			highestNewVersion = newVersion;
		}

		// Update changelog
		await updateChangelog(pkg.dir, newVersion);
	}
	console.log();

	// Update Rust version if natives package changed
	const nativesChanged = changedPackages.some((p) => p.dir === "packages/natives");
	if (nativesChanged) {
		console.log("Updating Rust workspace version...");
		await updateRustVersionIfNeeded(highestNewVersion);
		console.log();
	}

	// Regenerate lockfile
	console.log("Regenerating lockfile...");
	await $`rm -f bun.lock`.quiet();
	await $`bun install`.quiet();
	console.log("  Done\n");

	// Commit and tag
	const changedNames = changedPackages.map((p) => p.name.replace("@nghyane/arcane-", "").replace("@nghyane/", "")).join(", ");
	const commitMsg = `chore: release ${changedNames}`;

	console.log("Committing and tagging...");
	await $`git add .`;
	await $`git commit -m ${commitMsg}`.quiet();

	// Per-package tags for version tracking
	for (const tag of tags) {
		await $`git tag ${tag}`;
		console.log(`  Tagged ${tag}`);
	}

	// Single trigger tag for CI (one CI run publishes everything)
	const releaseTag = `release/${new Date().toISOString().replace(/[:.]/g, "-")}`;
	await $`git tag ${releaseTag}`;
	console.log(`  Tagged ${releaseTag} (CI trigger)`);
	console.log();

	// Push commit first, then tags separately — GitHub won't trigger tag-based workflows
	// if branch and tags are pushed in the same command.
	console.log("Pushing to remote...");
	const allNewTags = [...tags, releaseTag];
	await $`git push origin main`.quiet();
	await $`git push origin ${allNewTags.map(t => `refs/tags/${t}`)}`.quiet();
	console.log();

	console.log(`=== Released: ${tags.join(", ")} ===`);
	console.log("CI will publish changed packages automatically.");
}

await main();
