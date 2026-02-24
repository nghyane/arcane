# GitHub

Access GitHub repositories, issues, pull requests, and code search via the GitHub API with authentication and rate limit handling.

## When to use
- Reading files or directory trees from remote GitHub repositories
- Searching code or repositories across GitHub
- Reading issues, pull requests, and their comments/diffs
- Viewing commit history and details
- Getting repository metadata

## When NOT to use
- Local repository operations (use Read, Grep, Find, Bash with git)
- Creating or modifying GitHub resources (issues, PRs, comments) — this tool is read-only
- General web fetching (use Fetch)

## Parameters

### `action` (required)
The operation to perform. One of:

|Action|Description|
|---|---|
|`get_repo`|Get repository metadata (description, default branch, topics, stars)|
|`get_file`|Read a file from a remote repository|
|`get_tree`|List directory contents or full repository tree|
|`search_code`|Search code across GitHub repositories|
|`search_repos`|Search for repositories|
|`get_issue`|Get an issue with all comments|
|`list_issues`|List issues for a repository|
|`get_pull`|Get a pull request with optional diff|
|`list_pulls`|List pull requests for a repository|
|`list_commits`|List commits, optionally filtered by path|
|`get_commit`|Get a single commit with optional diff|

### `owner` (required)
Repository owner (user or organization).

### `repo` (required)
Repository name.

### Action-specific parameters
- **`path`**: File or directory path (for `get_file`, `get_tree`, `list_commits`)
- **`ref`**: Branch, tag, or commit SHA (for `get_file`, `get_tree`). Defaults to the repository's default branch.
- **`number`**: Issue or PR number (for `get_issue`, `get_pull`)
- **`query`**: Search query string (for `search_code`, `search_repos`)
- **`state`**: Filter by state: `open`, `closed`, `all` (for `list_issues`, `list_pulls`)
- **`labels`**: Comma-separated label names (for `list_issues`)
- **`sha`**: Commit SHA, branch, or tag (for `get_commit`, `list_commits`)
- **`include_diff`**: Include file diffs (for `get_pull`, `get_commit`). Default: false.
- **`per_page`**: Results per page, max 100 (for list/search actions). Default: 30.
- **`recursive`**: Recursively list tree (for `get_tree`). Default: false.

<conditions>
- Requires `GITHUB_TOKEN`, `GH_TOKEN` environment variable, or `gh auth login` for authenticated access
- Unauthenticated requests are limited to 60/hour; authenticated to 5,000/hour
- Rate limits are handled automatically with retry and backoff
- Responses are cached using ETags to minimize API usage
</conditions>