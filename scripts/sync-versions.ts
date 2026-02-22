#!/usr/bin/env bun

/**
 * Syncs inter-package dependency versions across the monorepo.
 * Each package maintains its own version independently.
 * This script ensures dependency references match actual package versions.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface PackageJson {
	name: string;
	version: string;
	private?: boolean;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface PackageInfo {
	path: string;
	data: PackageJson;
}

const packagesDir = path.join(process.cwd(), "packages");
const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
	.filter((dirent) => dirent.isDirectory())
	.map((dirent) => dirent.name);

const packages: Record<string, PackageInfo> = {};
const versionMap: Record<string, string> = {};

for (const dir of packageDirs) {
	const pkgPath = path.join(packagesDir, dir, "package.json");
	try {
		const content = fs.readFileSync(pkgPath, "utf-8");
		const pkg = JSON.parse(content) as PackageJson;
		packages[dir] = { path: pkgPath, data: pkg };
		versionMap[pkg.name] = pkg.version;
	} catch (e) {
		const error = e as Error;
		console.error(`Failed to read ${pkgPath}:`, error.message);
	}
}

console.log("Current versions:");
for (const [name, version] of Object.entries(versionMap).sort()) {
	console.log(`  ${name}: ${version}`);
}

// Update all inter-package dependencies to match actual versions
let totalUpdates = 0;
for (const [_dir, pkg] of Object.entries(packages)) {
	let updated = false;

	if (pkg.data.dependencies) {
		for (const [depName, currentVersion] of Object.entries(pkg.data.dependencies)) {
			if (versionMap[depName]) {
				const newVersion = `^${versionMap[depName]}`;
				if (currentVersion !== newVersion && currentVersion !== "workspace:*") {
					console.log(`\n${pkg.data.name}:`);
					console.log(`  ${depName}: ${currentVersion} -> ${newVersion}`);
					pkg.data.dependencies[depName] = newVersion;
					updated = true;
					totalUpdates++;
				}
			}
		}
	}

	if (pkg.data.devDependencies) {
		for (const [depName, currentVersion] of Object.entries(pkg.data.devDependencies)) {
			if (versionMap[depName]) {
				const newVersion = `^${versionMap[depName]}`;
				if (currentVersion !== newVersion && currentVersion !== "workspace:*") {
					console.log(`\n${pkg.data.name}:`);
					console.log(`  ${depName}: ${currentVersion} -> ${newVersion}`);
					pkg.data.devDependencies[depName] = newVersion;
					updated = true;
					totalUpdates++;
				}
			}
		}
	}

	if (updated) {
		fs.writeFileSync(pkg.path, JSON.stringify(pkg.data, null, "\t") + "\n");
	}
}

if (totalUpdates > 0) {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
} else {
	console.log("\nAll inter-package dependencies are up to date.");
}
