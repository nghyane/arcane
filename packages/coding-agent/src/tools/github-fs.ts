import type { AgentTool, AgentToolResult } from "@nghyane/arcane-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../theme/theme";
import { githubClient } from "../web/github-client";
import type { ToolSession } from ".";
import { formatGitHubError, resolveOwnerRepo } from "./github-utils";
import { type OutputMeta, toolResult } from "./output-meta";

// =============================================================================
// GitHub API Types
// =============================================================================

interface GitHubTreeEntry {
	type: string;
	path?: string;
	name?: string;
	size?: number;
}

// =============================================================================
// Schema
// =============================================================================
const ActionEnum = Type.Union([Type.Literal("get_file"), Type.Literal("get_tree")]);

const schema = Type.Object({
	action: ActionEnum,
	owner: Type.Optional(
		Type.String({ description: "Repository owner (user or org). Auto-detected from git remote if omitted." }),
	),
	repo: Type.Optional(Type.String({ description: "Repository name. Auto-detected from git remote if omitted." })),
	path: Type.Optional(Type.String({ description: "File or directory path within the repo" })),
	ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA" })),
	recursive: Type.Optional(Type.Boolean({ description: "Recursively list tree contents" })),
	limit: Type.Optional(Type.Number({ description: "Max number of results" })),
});

type GitHubFsInput = Static<typeof schema>;

// =============================================================================
// Details
// =============================================================================

export interface GitHubFsToolDetails {
	action: string;
	owner: string;
	repo: string;
	meta?: OutputMeta;
}

// =============================================================================
// Helpers
// =============================================================================

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

// =============================================================================
// Action Handlers
// =============================================================================

const MAX_FILE_LINES = 500;

async function handleAction(
	input: GitHubFsInput,
	owner: string,
	repo: string,
	signal?: AbortSignal,
): Promise<{ text: string; url?: string }> {
	const { action } = input;
	const opts = { signal };
	const base = `/repos/${owner}/${repo}`;

	switch (action) {
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
			if (!res.ok) return formatGitHubError(res, `file ${filePath}`);
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
				if (!res.ok) return formatGitHubError(res, "tree");
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
			if (!res.ok) return formatGitHubError(res, "directory");
			const entries = Array.isArray(res.data) ? res.data : [res.data];
			return {
				text: `# ${owner}/${repo}/${treePath}\n\n${entries.map(formatTreeEntry).join("\n")}`,
			};
		}

		default:
			return { text: `Unknown action: ${action}` };
	}
}

// =============================================================================
// Tool Class
// =============================================================================

export class GitHubFsTool implements AgentTool<typeof schema, GitHubFsToolDetails, Theme> {
	readonly name = "github_fs";
	readonly label = "GitHub FS";
	readonly parameters = schema;
	description = "Browse remote GitHub repository contents: read files and list directory trees.";

	constructor(readonly _session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: GitHubFsInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<GitHubFsToolDetails>> {
		const resolved = await resolveOwnerRepo(params, this._session.cwd);
		if (!resolved) {
			return toolResult({ action: params.action, owner: "", repo: "" } as GitHubFsToolDetails)
				.text(
					"Error: owner and repo are required. Provide them explicitly or run from a git repo with a GitHub remote.",
				)
				.done();
		}

		const { owner, repo } = resolved;
		const details: GitHubFsToolDetails = {
			action: params.action,
			owner,
			repo,
		};

		const result = await handleAction(params, owner, repo, signal);

		const builder = toolResult(details).text(result.text);
		if (result.url) {
			builder.sourceUrl(result.url);
		}
		return builder.done();
	}
}
