#!/usr/bin/env bun
/**
 * Detect which packages changed since their last published version.
 *
 * For each non-private package, finds the most recent tag matching that package
 * (e.g., @nghyane/arcane-utils@0.1.3) and checks if any files under its directory
 * changed since that tag. Also resolves dependency cascade — if a dependency was
 * bumped, dependents are included.
 *
 * Usage:
 *   bun scripts/detect-changes.ts          # prints changed package dirs
 *   import { detectChangedPackages } from "./detect-changes.ts"  # programmatic
 */

import { $, Glob } from "bun";
import * as path from "node:path";

interface PackageInfo {
	dir: string;
	name: string;
	version: string;
	private: boolean;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
}

const packageJsonGlob = new Glob("packages/*/package.json");

async function loadPackages(): Promise<PackageInfo[]> {
	const packages: PackageInfo[] = [];
	for await (const pkgPath of packageJsonGlob.scan(".")) {
		const pkg = await Bun.file(pkgPath).json();
		packages.push({
			dir: path.dirname(pkgPath),
			name: pkg.name,
			version: pkg.version,
			private: pkg.private ?? false,
			dependencies: pkg.dependencies ?? {},
			devDependencies: pkg.devDependencies ?? {},
		});
	}
	return packages;
}

async function getLastTagForPackage(name: string): Promise<string | null> {
	// Look for per-package tag first: @nghyane/arcane-utils@0.1.3
	const result = await $`git tag -l --sort=-v:refname ${name + "@*"}`.quiet().nothrow();
	const tags = result.text().trim().split("\n").filter(Boolean);
	if (tags.length > 0) return tags[0];

	// Fallback: legacy v* tag (from lockstep era)
	const legacy = await $`git tag -l --sort=-v:refname "v*"`.quiet().nothrow();
	const legacyTags = legacy.text().trim().split("\n").filter(Boolean);
	return legacyTags.length > 0 ? legacyTags[0] : null;
}

async function getChangedFilesSinceTag(tag: string): Promise<string[]> {
	const result = await $`git diff --name-only ${tag}..HEAD`.quiet().nothrow();
	if (result.exitCode !== 0) return [];
	return result.text().trim().split("\n").filter(Boolean);
}

async function getChangedFilesSinceEver(): Promise<string[]> {
	const result = await $`git ls-files`.quiet().nothrow();
	return result.text().trim().split("\n").filter(Boolean);
}

function filesBelongToPackage(files: string[], pkgDir: string): boolean {
	return files.some((f) => f.startsWith(pkgDir + "/"));
}

export async function detectChangedPackages(): Promise<PackageInfo[]> {
	const allPackages = await loadPackages();
	const publicPackages = allPackages.filter((p) => !p.private);

	// Detect directly changed packages
	const changed = new Set<string>();

	for (const pkg of publicPackages) {
		const tag = await getLastTagForPackage(pkg.name);
		const files = tag
			? await getChangedFilesSinceTag(tag)
			: await getChangedFilesSinceEver();

		if (filesBelongToPackage(files, pkg.dir)) {
			changed.add(pkg.name);
		}
	}

	// Also check shared files that affect all packages (root config, crates/)
	const rootTag = await getLastTagForPackage(publicPackages[0]?.name ?? "");
	const allFiles = rootTag
		? await getChangedFilesSinceTag(rootTag)
		: [];

	const sharedPrefixes = ["crates/"];
	const hasSharedChanges = allFiles.some((f) =>
		sharedPrefixes.some((prefix) => f.startsWith(prefix)),
	);

	if (hasSharedChanges) {
		// crates/ changes affect natives package
		const natives = publicPackages.find((p) => p.dir === "packages/natives");
		if (natives) changed.add(natives.name);
	}

	// Dependency cascade: if X changed and Y depends on X, Y is also changed
	let cascadePass = true;
	while (cascadePass) {
		cascadePass = false;
		for (const pkg of publicPackages) {
			if (changed.has(pkg.name)) continue;
			const allDeps = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
			if (allDeps.some((dep) => changed.has(dep))) {
				changed.add(pkg.name);
				cascadePass = true;
			}
		}
	}

	return publicPackages.filter((p) => changed.has(p.name));
}

// CLI mode
if (import.meta.main) {
	const packages = await detectChangedPackages();
	if (packages.length === 0) {
		console.log("No packages changed since last release.");
		process.exit(0);
	}
	console.log("Changed packages:");
	for (const pkg of packages) {
		console.log(`  ${pkg.name} (${pkg.dir}) — current: ${pkg.version}`);
	}
}
