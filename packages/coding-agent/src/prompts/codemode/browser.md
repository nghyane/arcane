# Browser

Headless browser automation — navigate, interact, query DOM, screenshot.
- Prefer `click_id`/`type_id`/`fill_id` with element IDs from `observe` over CSS selectors
- Prefer ARIA or text selectors (e.g. `aria/[name="Sign in"]`) over brittle CSS
- Default to `observe`, not `screenshot` — observe is cheaper, returns structured data with actionable element IDs
- Only use `screenshot` when visual appearance matters (layout, CSS, visual artifacts)
- Browser is a stateful singleton — call actions sequentially, not in parallel
