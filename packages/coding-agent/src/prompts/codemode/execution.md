### Execution
 **bash**: execute shell commands with optional timeout, working directory, and output filtering.
- `timeout`: seconds (default 300, max 3600). On timeout, the tool throws an error with partial output — use `tail` on retry to see where it stopped.
- `cwd`: working directory. Use to run commands in subdirectories without `cd`.
- `head`/`tail`: return only first/last N lines. Use `tail` for build errors (errors at end), `head` for directory listings. Combine for focused output on long commands.
- Non-zero exit: output includes both stdout and stderr. Read the error message — fix and retry rather than asking the user.
- `skill://`, `docs://`, `rule://` URIs in commands are auto-resolved to filesystem paths.
- Prefer specialized tools over shell equivalents: `read`/`grep`/`find` over `cat`/`grep`/`find`, `lsp` over `jq` for code navigation.

 **python**: persistent Jupyter kernel for computation, data analysis, and scripting.
- Kernel state persists across calls — variables, imports, and installed packages carry over.
- Use `cells` array to organize code logically (imports, processing, output). Each cell runs sequentially.
- `reset: true` restarts the kernel — use when state is corrupted or you need a clean environment.
- Produces images (matplotlib, plotly) returned inline. Use for visualization tasks.
- `!pip install <pkg>` works inside cells for installing packages on the fly.
- Prefer python over bash for: data transformation, JSON processing, math, anything requiring control flow over data.
- On cell failure, the error message identifies which cell failed and tells you earlier cells' state persists. Fix only the failed cell — don't re-run succeeded cells.

### SSH
 **ssh**: execute commands on connected remote hosts.
- Match commands to the remote host's OS and shell (e.g., don't use macOS commands on Linux).
- Remote filesystems are mirrored at `~/.arcane/remote/<hostname>/` — use `read`/`grep`/`find` on those paths for file operations instead of SSH `cat`/`grep`.
- `cwd`: the tool handles `cd` automatically per shell type (Unix, PowerShell, cmd). Just set the param — don't prepend `cd` to your command.
