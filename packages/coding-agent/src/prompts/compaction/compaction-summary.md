Summarize conversation above into structured context checkpoint handoff summary for another LLM to resume task.

IMPORTANT: If conversation ends with unanswered question to user or imperative/request awaiting user response (e.g., "Please run command and paste output"), preserve that exact question/request.

Use this format (sections can be omitted if not applicable):

## Goal
[User goals; list multiple if session covers different tasks.]

## Constraints & Preferences
- [Constraints or requirements mentioned]

## Progress

### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress]

### Abandoned Approaches
- [Approach tried and why it failed/was rejected — prevents re-trying dead ends]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Important data, pending questions, references]

## Additional Notes
[Anything else important not covered above]

Output only structured summary; no extra text.

Prioritize recent context over older context — the last 2-3 turns are most likely to contain the active work state. Preserve exact file paths, function names, error messages, and relevant tool outputs. Include repository state changes (branch, uncommitted changes) if mentioned.
