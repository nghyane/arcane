# Review

Review code changes using a specialized code review subagent. The reviewer identifies bugs the author would want fixed before merge — not style issues, not pre-existing bugs.

## When to use
- Review uncommitted changes, a specific commit, or a PR diff
- Check code quality and correctness of recent modifications
- Analyze a diff for bugs, security issues, or logic errors

## When NOT to use
- Simple file reading or code understanding (use Read/Grep/Explore)
- Making code changes (use Edit/Write/Task)

## Parameters

### `diff_description` (required)

A description or command that identifies the diff to review. Examples:
- `"uncommitted changes"` — reviews `git diff`
- `"last commit"` — reviews `git show HEAD`
- `"PR #42"` — reviews `gh pr diff 42`
- `"changes against main branch"` — reviews `git diff main...HEAD`

### `files` (optional)

Array of specific file paths to focus the review on. If omitted, all changed files are reviewed.

### `instructions` (optional)

Additional guidance for the reviewer. Examples:
- `"Focus on error handling"`
- `"Check for race conditions in the async code"`
- `"Verify backward compatibility"`

## Output

Returns structured review with:
- `overall_correctness`: "correct" or "incorrect"
- `explanation`: 1-3 sentence verdict summary
- `confidence`: 0.0-1.0
- `findings`: list of issues found, each with title, body, priority (P0-P3), file path, and line range