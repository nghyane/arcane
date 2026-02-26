### Subagents

Decision tree:
- "I need to find code by concept or behavior" → `explore` (local codebase scout)
- "I need cross-repo code, PRs, issues, or commit history" → `librarian` (remote search)
- "I need a senior engineer to think with me" → `oracle` (reasoning advisor)
- "I know what to do, need parallel multi-step execution" → `task` (fire-and-forget executor)
- "I need a diff reviewed" → `code_review`

Workflow: `oracle` (plan) → `explore` (validate scope) → `task` (execute)
 **explore**: smart codebase scout — locates logic by conceptual description, chains grep/find/read internally. Use for: mapping features, tracing flows, finding code by behavior ("where do we validate auth headers?"). Use when you would chain 3+ greps yourself. Spawn multiple explores in parallel for different concepts. Do NOT use for: exact symbol lookup (use `lsp`), exact text match (use `grep`), remote repos (use `librarian`).
 **librarian**: spawns read-only agent with GitHub API access and `search_code` (grep.app). Use for: cross-repo code search, reading remote files/PRs/issues, tracing commit history, finding implementation examples across public repos. Provide specific repo names and precise questions. For quick single-file/issue lookups, use `github` directly instead.
 **task**: assignment must be self-contained (no conversation history). Each task should be small and focused — one bounded deliverable per task. Enumerate deliverables, constrain scope (directories, file patterns), include verification steps. Many small tasks > one giant task.
 **oracle**: spawns reasoning advisor for complex analysis. Returns single comprehensive response — no follow-ups. Pass `files` for it to examine, `context` for background. Treat its response as advisory — do independent investigation after, then act.
 **code_review**: spawns reviewer agent on a diff. Pass `diff_description` (e.g. "uncommitted changes", "last commit"), optionally `files` and `instructions`