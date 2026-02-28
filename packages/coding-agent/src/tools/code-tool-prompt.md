Execute JavaScript code to accomplish tasks. Instead of calling tools individually, write an async arrow function that orchestrates multiple operations.

## Available API

```typescript
{{types}}
```

## Rules

- Write an async arrow function: `async () => { ... }`
- Use `await` for all `codemode.*` calls
- Default to `Promise.all()` — serialize only when there is a strict data dependency. Do not limit parallel calls to 3-4; batch as many independent operations as possible. Use `Promise.allSettled()` when partial failure is acceptable
- Do not make multiple edits to the same file in parallel
- Return the final result from your function
- Tool results are already displayed to the user — do NOT repeat raw output in your response text. Summarize or analyze instead.
- Do NOT use `console.log()` — tool results are already streamed to the UI as they execute
- Handle errors with try/catch when needed
- Browser and notebook are stateful singletons — call actions sequentially, not in parallel
- Prefer smaller parallel edits over one massive sequential operation — fan out when targets are disjoint
- Always read a file before editing it — never edit blind
## Persistent State

A `state` Map and `memo` helper persist across all code executions in the conversation.

- `state` — raw Map for manual get/set
- `memo(key, fn)` — cache-on-first-call: returns cached value or calls `fn`, caches, and returns

## Step, Progress, and Abort

Use `step()` to group related operations under a named intent. The TUI renders steps as collapsible sections.

- `step(intent, fn)` — groups sub-tool calls under a named intent. Supports nesting and parallel (`Promise.all([step(...), step(...)])`)
- `progress(message)` — transient status under current step. Replaces previous. Only works inside `step()`
- `abort(message)` — clean exit without error framing. Use when stopping is intentional (e.g., nothing to do)

## Examples

Parallel reads, then parallel edits, then verify:
```javascript
async () => {
  const [src, test] = await Promise.all([
    codemode.read({ path: "src/app.ts" }),
    codemode.read({ path: "test/app.test.ts" }),
  ]);

  await Promise.all([
    codemode.edit({ path: "src/app.ts", edits: [...] }),
    codemode.edit({ path: "test/app.test.ts", edits: [...] }),
  ]);

  return await codemode.bash({ command: "bun test" });
}
```

Using step and progress:
```javascript
async () => {
  await step("Reading source files", async () => {
    progress("Searching...");
    const [a, b] = await Promise.all([
      codemode.read({ path: "src/a.ts" }),
      codemode.read({ path: "src/b.ts" }),
    ]);
  });

  await step("Applying fixes", async () => {
    for (const file of files) {
      progress(`Processing ${file}...`);
      await codemode.edit({ path: file, edits: [...] });
    }
  });
}
```
