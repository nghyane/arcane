import { $ } from "bun";
import type { GitHubResponse } from "../web/github-client";

export async function resolveOwnerRepo(
	input: { owner?: string; repo?: string },
	cwd: string,
): Promise<{ owner: string; repo: string } | null> {
	if (input.owner && input.repo) return { owner: input.owner, repo: input.repo };
	try {
		const result = await $`git remote get-url origin`.cwd(cwd).quiet().nothrow();
		if (result.exitCode !== 0) return null;
		const url = result.text().trim();
		// https://github.com/owner/repo.git or git@github.com:owner/repo.git
		const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
		if (!match) return null;
		return { owner: match[1], repo: match[2] };
	} catch {
		return null;
	}
}

export function formatGitHubError(res: GitHubResponse, resource: string): { text: string } {
	const status = res.status;
	if (status === 404) return { text: `Error: ${resource} not found (404)` };
	if (status === 403) {
		const rl = res.rateLimit;
		if (rl && rl.remaining === 0) {
			return { text: `Error: GitHub API rate limit exceeded. Resets at ${new Date(rl.reset * 1000).toISOString()}` };
		}
		return { text: `Error: Access denied to ${resource} (403). Check token permissions.` };
	}
	if (status === 401)
		return { text: `Error: Authentication failed (401). Check GITHUB_TOKEN or run 'gh auth login'.` };
	return { text: `Error: Failed to fetch ${resource} (HTTP ${status})` };
}
