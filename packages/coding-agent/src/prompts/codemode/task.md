# Task

Launch a subagent to execute a well-scoped task. Subagent has full tools but no conversation history — assignment must be self-contained.
- Use for: multi-file implementations, refactors, migrations, boilerplate
- Do NOT use for: exploratory work, architectural decisions, single-file edits
- `assignment`: Complete instructions — Target (files, symbols), Change (steps), Edge Cases, Acceptance Criteria
- `context`: Shared background prepended to assignment — API contracts, type defs, reference files. Do NOT repeat AGENTS.md rules
- `skills`: Skill names to preload into the subagent
- Use `Promise.all()` for parallel tasks when they are independent