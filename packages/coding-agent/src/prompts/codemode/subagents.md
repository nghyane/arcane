### Subagents
 **task**: assignment must be self-contained (no conversation history). Each task should be small and focused — one bounded deliverable per task. Enumerate deliverables, constrain scope (directories, file patterns), include verification steps. Many small tasks > one giant task.
 **oracle**: spawns reasoning advisor for complex analysis. Returns single comprehensive response — no follow-ups. Pass `files` for it to examine, `context` for background. Treat its response as advisory — do independent investigation after, then act.
 **code_review**: spawns reviewer agent on a diff. Pass `diff_description` (e.g. "uncommitted changes", "last commit"), optionally `files` and `instructions`

