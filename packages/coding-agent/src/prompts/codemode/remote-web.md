### Remote & Web
 **github**: direct GitHub API access — `get_file`, `get_tree`, `search_code`, `get_issue`, `list_issues`, `get_pull`, `list_pulls`, `list_commits`, `get_commit`. Use for quick targeted lookups (single file, issue, PR).
 **librarian**: spawns read-only agent with GitHub API access. Can search code across repos, read files/PRs/issues, trace commit history, explore repo architecture. Provide specific repo names and precise questions. For quick single-file/issue lookups, use `github` directly instead.
 **web_search**: search the web for up-to-date documentation, API references, error messages, or information not available in the codebase. Use when you need current info (library versions, changelog, migration guides). For a specific URL you already have, use `fetch` instead.
 **fetch**: fetch a specific URL and return its content as text/markdown. Use when you have a known URL (docs page, API endpoint, issue link). Do NOT use for localhost or local URLs — use `codemode.bash({ command: "curl ..." })` instead.

