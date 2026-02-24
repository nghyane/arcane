# Bash

Shell commands — git, build tools, system operations.
- Use `cwd` parameter instead of `cd dir && ...`
- Use `head`/`tail` parameters instead of `| head -n`/`| tail -n` pipes
- stdout and stderr are already merged — do not use `2>&1`
- `skill://`, `docs://`, `rule://` URIs are auto-resolved to filesystem paths
- Do NOT use bash for read, grep, find, edit, write — use specialized tools
