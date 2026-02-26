### Remote & Web
 **github**: direct GitHub API access for targeted lookups — single file, issue, PR, commit.
 Actions: `get_file`, `get_tree`, `get_issue`, `list_issues`, `get_pull`, `list_pulls`, `list_commits`, `get_commit`, `search_repos`.
 Use `ref` to pin to a branch/tag/SHA when reading files or trees.
 Use `include_diff: true` on `get_commit`/`get_pull` to see actual changes.
- `list_*` actions return up to `limit` results (default 100, max 500). If you need more, narrow with filters (`state`, `labels`) rather than paginating.
 For bulk exploration (searching code across repos, reading multiple files, tracing history), use `librarian` instead — it has `search_code` (grep.app) and can chain multiple GitHub calls.

 **web_search**: search the web for current information not available in the codebase.
 Best for: library docs, API references, error messages, migration guides, changelog lookups.
 `provider`: defaults to `auto` (picks best available). Specify explicitly only when a provider has unique strength (e.g., `perplexity` for synthesized answers, `brave` for recency).
 `recency`: filter results by age (`day`, `week`, `month`, `year`). Use for fast-moving topics (release notes, security advisories).
 For a specific URL you already know, use `fetch` instead — faster and more complete.
- On failure, returns `"Error: ..."` text (does not throw). If all providers fail, try a different query or use `fetch` directly if you have a URL.

 **fetch**: retrieve content from a known URL as text/markdown.
 Converts HTML to readable markdown by default. Use `raw: true` for unprocessed HTML when you need structure.
 Handles PDFs, Office docs, and images via conversion.
 Do NOT use for localhost/local URLs — use `bash` with `curl` instead.
 Output is capped; for very large pages, the content will be truncated.
- Pages requiring JavaScript return low-quality or empty content. If output looks like navigation-only, try a different URL or fall back to `web_search`.

 **search_code**: search source code across public GitHub repositories via grep.app.
- Use for finding real-world usage patterns, implementation examples, or how other projects solve similar problems.
- `repo`: filter to a specific repository (e.g., `vercel/next.js`).
- `language`: filter by programming language.
- `regexp: true`: enable regex patterns for complex searches.
- For searching within the current codebase, use `grep` instead.