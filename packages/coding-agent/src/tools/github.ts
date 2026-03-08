import type { AgentTool, AgentToolResult } from "@nghyane/arcane-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../theme/theme";
import { type GitHubResponse, githubClient } from "../web/github-client";
import type { ToolSession } from ".";
import { type OutputMeta, toolResult } from "./output-meta";

// =============================================================================
// GitHub API Types
// =============================================================================

interface GitHubUser {
	login: string;
}

interface GitHubLabel {
	name: string;
}

interface GitHubLicense {
	spdx_id: string;
}

interface GitHubRepo {
	full_name: string;
	description: string | null;
	default_branch: string;
	language: string | null;
	stargazers_count: number;
	forks_count: number;
	topics: string[];
	license: GitHubLicense | null;
	created_at: string;
	updated_at: string;
	homepage: string | null;
}

interface GitHubTreeEntry {
	type: string;
	path?: string;
	name?: string;
	size?: number;
}

interface GitHubIssue {
	number: number;
	title: string;
	state: string;
	user: GitHubUser | null;
	labels: GitHubLabel[];
	assignees: GitHubUser[];
	body: string | null;
	created_at: string;
	pull_request?: unknown;
}

interface GitHubComment {
	user: GitHubUser | null;
	created_at: string;
	body: string | null;
}

interface GitHubPR {
	number: number;
	title: string;
	state: string;
	merged: boolean;
	merged_at: string | null;
	user: GitHubUser | null;
	base: { ref: string };
	head: { ref: string };
	changed_files: number | null;
	additions: number;
	deletions: number;
	body: string | null;
}

interface GitHubCommitAuthor {
	name: string;
	email: string;
	date: string;
}

interface GitHubCommitFile {
	status: string;
	filename: string;
	additions: number;
	deletions: number;
}

interface GitHubCommit {
	sha: string;
	commit: {
		author: GitHubCommitAuthor;
		message: string;
	};
	author: GitHubUser | null;
	stats?: { total: number; additions: number; deletions: number };
	files?: GitHubCommitFile[];
}

interface GitHubSearchResult<T> {
	total_count: number;
	items: T[];
}

// =============================================================================
// Schema
// =============================================================================
const ActionEnum = Type.Union([
	Type.Literal("get_repo"),
	Type.Literal("get_file"),
	Type.Literal("get_tree"),
	Type.Literal("search_repos"),
	Type.Literal("get_issue"),
	Type.Literal("list_issues"),
	Type.Literal("get_pull"),
	Type.Literal("list_pulls"),
	Type.Literal("list_commits"),
	Type.Literal("get_commit"),
]);

const schema = Type.Object({
	action: ActionEnum,
	owner: Type.String({ description: "Repository owner (user or org)" }),
	repo: Type.String({ description: "Repository name" }),
	path: Type.Optional(Type.String({ description: "File or directory path within the repo" })),
	ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA" })),
	number: Type.Optional(Type.Number({ description: "Issue or PR number" })),
	query: Type.Optional(Type.String({ description: "Search query or SSR pattern" })),
	state: Type.Optional(Type.String({ description: "Filter by state (open, closed, all)" })),
	labels: Type.Optional(Type.String({ description: "Comma-separated label filter" })),
	sha: Type.Optional(Type.String({ description: "Commit SHA" })),
	include_diff: Type.Optional(Type.Boolean({ description: "Include diff in commit details" })),
	recursive: Type.Optional(Type.Boolean({ description: "Recursively list tree contents" })),
	limit: Type.Optional(Type.Number({ description: "Max number of results" })),
});

type GitHubInput = Static<typeof schema>;

// =============================================================================
// Details
// =============================================================================

export interface GitHubToolDetails {
	action: string;
	owner: string;
	repo: string;
	meta?: OutputMeta;
}

// =============================================================================
// Response Formatters
// =============================================================================

function formatRepo(data: GitHubRepo): string {
	return [
		`# ${data.full_name}`,
		data.description ? `${data.description}` : "",
		"",
		`- Default branch: ${data.default_branch}`,
		`- Language: ${data.language ?? "N/A"}`,
		`- Stars: ${data.stargazers_count} | Forks: ${data.forks_count}`,
		`- Topics: ${data.topics?.length ? data.topics.join(", ") : "none"}`,
		`- License: ${data.license?.spdx_id ?? "N/A"}`,
		`- Created: ${data.created_at} | Updated: ${data.updated_at}`,
		data.homepage ? `- Homepage: ${data.homepage}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function formatTreeEntry(entry: GitHubTreeEntry): string {
	const icon = entry.type === "dir" || entry.type === "tree" ? "dir" : "file";
	const size = entry.size ? ` (${formatSize(entry.size)})` : "";
	const name = entry.path ?? entry.name;
	return `[${icon}] ${name}${size}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatIssue(data: GitHubIssue, comments: GitHubComment[] = []): string {
	const lines = [
		`# #${data.number}: ${data.title}`,
		`State: ${data.state} | Author: @${data.user?.login} | Created: ${data.created_at}`,
		data.labels?.length ? `Labels: ${data.labels.map(l => l.name).join(", ")}` : "",
		data.assignees?.length ? `Assignees: ${data.assignees.map(a => `@${a.login}`).join(", ")}` : "",
		"",
		data.body ?? "(no description)",
	].filter(l => l !== "");

	for (const comment of comments) {
		lines.push("", `---`, `**@${comment.user?.login}** on ${comment.created_at}:`, "", comment.body ?? "");
	}

	return lines.join("\n");
}

function formatIssueMinimal(issue: GitHubIssue): string {
	const labels = issue.labels?.length ? ` [${issue.labels.map(l => l.name).join(", ")}]` : "";
	return `#${issue.number} [${issue.state}] ${issue.title}${labels} (@${issue.user?.login}, ${issue.created_at})`;
}

function formatPR(data: GitHubPR, diff?: string): string {
	const lines = [
		`# PR #${data.number}: ${data.title}`,
		`State: ${data.state}${data.merged ? " (merged)" : ""} | Author: @${data.user?.login}`,
		`Base: ${data.base?.ref} <- Head: ${data.head?.ref}`,
		`Changed files: ${data.changed_files ?? "?"} | +${data.additions ?? 0} -${data.deletions ?? 0}`,
		"",
		data.body ?? "(no description)",
	];

	if (diff) {
		lines.push("", "## Diff", "", `\`\`\`diff`, diff, `\`\`\``);
	}

	return lines.join("\n");
}

function formatPRMinimal(pr: GitHubPR): string {
	const merged = pr.merged_at ? " (merged)" : "";
	return `#${pr.number} [${pr.state}${merged}] ${pr.title} (@${pr.user?.login}, ${pr.base?.ref} <- ${pr.head?.ref})`;
}

function formatCommit(data: GitHubCommit, diff?: string): string {
	const lines = [
		`Commit: ${data.sha}`,
		`Author: ${data.commit?.author?.name} <${data.commit?.author?.email}>`,
		`Date: ${data.commit?.author?.date}`,
		"",
		data.commit?.message ?? "",
	];

	if (data.stats) {
		lines.push("", `Files changed: ${data.stats.total} | +${data.stats.additions} -${data.stats.deletions}`);
	}

	if (data.files?.length && !diff) {
		lines.push("", "Files:");
		for (const f of data.files) {
			lines.push(`  ${f.status} ${f.filename} (+${f.additions} -${f.deletions})`);
		}
	}

	if (diff) {
		lines.push("", "## Diff", "", `\`\`\`diff`, diff, `\`\`\``);
	}

	return lines.join("\n");
}

function formatCommitMinimal(c: GitHubCommit): string {
	const sha = (c.sha ?? "").slice(0, 7);
	const msg = (c.commit?.message ?? "").split("\n")[0];
	const author = c.commit?.author?.name ?? c.author?.login ?? "?";
	const date = c.commit?.author?.date ?? "";
	return `${sha} ${msg} (${author}, ${date})`;
}

function formatSearchReposResult(data: GitHubSearchResult<GitHubRepo>): string {
	const items = data.items ?? [];
	const lines = [`Found ${data.total_count} repositories (showing ${items.length}):`, ""];
	for (const item of items) {
		lines.push(`${item.full_name} (${item.stargazers_count}*) - ${item.description ?? "no description"}`);
	}
	return lines.join("\n");
}

// =============================================================================
// Action Handlers
// =============================================================================

const MAX_FILE_LINES = 500;
const MAX_DIFF_CHARS = 50_000;
const MAX_COMMENTS_PAGES = 5;

async function handleAction(input: GitHubInput, signal?: AbortSignal): Promise<{ text: string; url?: string }> {
	const { action, owner, repo } = input;
	const opts = { signal };
	const base = `/repos/${owner}/${repo}`;

	switch (action) {
		case "get_repo": {
			const res = await githubClient.request<GitHubRepo>(base, opts);
			if (!res.ok) return error(res, "repository");
			return { text: formatRepo(res.data), url: `https://github.com/${owner}/${repo}` };
		}

		case "get_file": {
			const filePath = input.path ?? "README.md";
			const ref = input.ref ? `?ref=${input.ref}` : "";
			let res = await githubClient.request<string>(`${base}/contents/${filePath}${ref}`, {
				...opts,
				mediaType: "application/vnd.github.v3.raw",
			});
			// Fallback to Blob API for files >1MB (raw mediaType returns 403)
			if (!res.ok && res.status === 403) {
				const metaRes = await githubClient.request<{ sha: string; size: number }>(
					`${base}/contents/${filePath}${ref}`,
					opts,
				);
				if (metaRes.ok && metaRes.data?.sha) {
					const blobRes = await githubClient.request<{ content: string; encoding: string }>(
						`${base}/git/blobs/${metaRes.data.sha}`,
						opts,
					);
					if (blobRes.ok && blobRes.data?.content) {
						const decoded =
							blobRes.data.encoding === "base64"
								? Buffer.from(blobRes.data.content, "base64").toString("utf-8")
								: blobRes.data.content;
						res = { data: decoded as string, ok: true, status: 200 };
					}
				}
			}
			if (!res.ok) return error(res, `file ${filePath}`);
			const content = String(res.data);
			const lines = content.split("\n");
			const truncated = lines.length > MAX_FILE_LINES;
			const output = truncated ? lines.slice(0, MAX_FILE_LINES).join("\n") : content;
			const note = truncated ? `\n\n[Truncated: showing ${MAX_FILE_LINES}/${lines.length} lines]` : "";
			return {
				text: `# ${owner}/${repo}:${filePath}${input.ref ? ` @${input.ref}` : ""}\n\n${output}${note}`,
				url: `https://github.com/${owner}/${repo}/blob/${input.ref ?? "HEAD"}/${filePath}`,
			};
		}

		case "get_tree": {
			const treePath = input.path ?? "";
			if (input.recursive) {
				const ref = input.ref ?? "HEAD";
				const res = await githubClient.request<{ tree: GitHubTreeEntry[]; truncated: boolean }>(
					`${base}/git/trees/${ref}?recursive=1`,
					opts,
				);
				if (!res.ok) return error(res, "tree");
				const entries = (res.data.tree ?? [])
					.filter(e => !treePath || (e.path ?? "").startsWith(treePath))
					.slice(0, 500);
				return {
					text: `# Tree: ${owner}/${repo}${treePath ? `/${treePath}` : ""} (recursive)\n\n${entries.map(formatTreeEntry).join("\n")}`,
				};
			}
			const ref = input.ref ? `?ref=${input.ref}` : "";
			const endpoint = treePath ? `${base}/contents/${treePath}${ref}` : `${base}/contents${ref}`;
			const res = await githubClient.request<GitHubTreeEntry[]>(endpoint, opts);
			if (!res.ok) return error(res, "directory");
			const entries = Array.isArray(res.data) ? res.data : [res.data];
			return {
				text: `# ${owner}/${repo}/${treePath}\n\n${entries.map(formatTreeEntry).join("\n")}`,
			};
		}

		case "search_repos": {
			const q = input.query ?? `${owner}/${repo}`;
			const perPage = Math.min(input.limit ?? 30, 100);
			const res = await githubClient.request<GitHubSearchResult<GitHubRepo>>(
				`/search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}`,
				opts,
			);
			if (!res.ok) return error(res, "repository search");
			return { text: formatSearchReposResult(res.data) };
		}

		case "get_issue": {
			const num = input.number;
			if (!num) return { text: "Error: 'number' is required for get_issue" };
			const [issueRes, commentsRes] = await Promise.all([
				githubClient.request<GitHubIssue>(`${base}/issues/${num}`, opts),
				githubClient.requestPaginated<GitHubComment>(`${base}/issues/${num}/comments`, {
					...opts,
					perPage: 100,
					maxPages: MAX_COMMENTS_PAGES,
				}),
			]);
			if (!issueRes.ok) return error(issueRes, `issue #${num}`);
			return {
				text: formatIssue(issueRes.data, commentsRes.ok ? commentsRes.data : []),
				url: `https://github.com/${owner}/${repo}/issues/${num}`,
			};
		}

		case "list_issues": {
			const params = new URLSearchParams();
			if (input.state) params.set("state", input.state);
			if (input.labels) params.set("labels", input.labels);
			const limit = Math.min(input.limit ?? 100, 500);
			const perPage = Math.min(limit, 100);
			const maxPages = Math.ceil(limit / perPage);
			const res = await githubClient.requestPaginated<GitHubIssue>(`${base}/issues?${params}`, {
				...opts,
				perPage,
				maxPages,
			});
			if (!res.ok) return error(res, "issues");
			const issues = (res.data ?? []).filter(i => !i.pull_request).slice(0, limit);
			const header = `${issues.length} issue(s)${issues.length >= limit ? " (limit reached, increase limit for more)" : ""}`;
			return {
				text: issues.length ? `${header}\n${issues.map(formatIssueMinimal).join("\n")}` : "No issues found.",
			};
		}

		case "get_pull": {
			const num = input.number;
			if (!num) return { text: "Error: 'number' is required for get_pull" };
			const prRes = await githubClient.request<GitHubPR>(`${base}/pulls/${num}`, opts);
			if (!prRes.ok) return error(prRes, `PR #${num}`);

			let diff: string | undefined;
			if (input.include_diff) {
				const diffRes = await githubClient.request<string>(`${base}/pulls/${num}`, {
					...opts,
					mediaType: "application/vnd.github.v3.diff",
				});
				if (diffRes.ok) {
					diff = String(diffRes.data);
					if (diff.length > MAX_DIFF_CHARS) {
						diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[Truncated at ${MAX_DIFF_CHARS} chars]`;
					}
				}
			}

			return {
				text: formatPR(prRes.data, diff),
				url: `https://github.com/${owner}/${repo}/pull/${num}`,
			};
		}

		case "list_pulls": {
			const params = new URLSearchParams();
			if (input.state) params.set("state", input.state);
			const limit = Math.min(input.limit ?? 100, 500);
			const perPage = Math.min(limit, 100);
			const maxPages = Math.ceil(limit / perPage);
			const res = await githubClient.requestPaginated<GitHubPR>(`${base}/pulls?${params}`, {
				...opts,
				perPage,
				maxPages,
			});
			if (!res.ok) return error(res, "pull requests");
			const pulls = (res.data ?? []).slice(0, limit);
			const header = `${pulls.length} PR(s)${pulls.length >= limit ? " (limit reached, increase limit for more)" : ""}`;
			return {
				text: pulls.length ? `${header}\n${pulls.map(formatPRMinimal).join("\n")}` : "No pull requests found.",
			};
		}

		case "list_commits": {
			const params = new URLSearchParams();
			if (input.sha) params.set("sha", input.sha);
			if (input.path) params.set("path", input.path);
			const limit = Math.min(input.limit ?? 100, 500);
			const perPage = Math.min(limit, 100);
			const maxPages = Math.ceil(limit / perPage);
			const res = await githubClient.requestPaginated<GitHubCommit>(`${base}/commits?${params}`, {
				...opts,
				perPage,
				maxPages,
			});
			if (!res.ok) return error(res, "commits");
			const commits = (res.data ?? []).slice(0, limit);
			const header = `${commits.length} commit(s)${commits.length >= limit ? " (limit reached, increase limit for more)" : ""}`;
			return {
				text: commits.length ? `${header}\n${commits.map(formatCommitMinimal).join("\n")}` : "No commits found.",
			};
		}

		case "get_commit": {
			const sha = input.sha;
			if (!sha) return { text: "Error: 'sha' is required for get_commit" };
			const res = await githubClient.request<GitHubCommit>(`${base}/commits/${sha}`, opts);
			if (!res.ok) return error(res, `commit ${sha}`);

			let diff: string | undefined;
			if (input.include_diff) {
				const diffRes = await githubClient.request<string>(`${base}/commits/${sha}`, {
					...opts,
					mediaType: "application/vnd.github.v3.diff",
				});
				if (diffRes.ok) {
					diff = String(diffRes.data);
					if (diff.length > MAX_DIFF_CHARS) {
						diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[Truncated at ${MAX_DIFF_CHARS} chars]`;
					}
				}
			}

			return {
				text: formatCommit(res.data, diff),
				url: `https://github.com/${owner}/${repo}/commit/${sha}`,
			};
		}

		default:
			return { text: `Unknown action: ${action}` };
	}
}

function error(res: GitHubResponse, resource: string): { text: string } {
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

// =============================================================================
// Tool Class
// =============================================================================

export class GitHubTool implements AgentTool<typeof schema, GitHubToolDetails, Theme> {
	readonly name = "github";
	readonly label = "GitHub";
	readonly parameters = schema;
	description =
		"Interact with GitHub API: repos, issues, PRs, commits. For remote repositories only — use read/grep for local files.";

	constructor(readonly _session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: GitHubInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<GitHubToolDetails>> {
		const input = params;
		const details: GitHubToolDetails = {
			action: input.action,
			owner: input.owner,
			repo: input.repo,
		};

		const result = await handleAction(input, signal);

		const builder = toolResult(details).text(result.text);
		if (result.url) {
			builder.sourceUrl(result.url);
		}
		return builder.done();
	}
}
