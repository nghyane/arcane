# Task

Launch a subagent to execute a well-scoped task. Subagent has full tools but no conversation history — assignment must be self-contained.
- `assignment`: Complete instructions — Target (files, symbols), Change (steps), Edge Cases, Acceptance Criteria
- `context`: Shared background prepended to assignment — API contracts, type defs, reference files. Do NOT repeat AGENTS.md rules
- Use `Promise.all()` for parallel tasks when they are independent
