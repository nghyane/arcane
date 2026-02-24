# GitHub

Remote GitHub API — repos, issues, PRs, code search, commits. Read-only, auto-paginates.
- `limit` controls max total results (default: 100, max: 500) with automatic pagination
- `get_file` falls back to Blob API for files >1MB
- `search_code` supports GitHub text-match fragments
- `include_diff` on `get_commit`/`get_pull` returns file-level diffs