# LSP

Semantic code intelligence — definition, references, hover, diagnostics, rename. Use over grep for type-aware queries.

Actions:
- `definition`: Go to symbol definition (file + line)
- `references`: Find all usages of a symbol across the codebase
- `hover`: Get type signature and documentation
- `symbols`: List symbols in file, or search workspace (with `query`, no `file`)
- `rename`: Rename symbol across codebase (applies edits automatically)
- `diagnostics`: Get errors/warnings for specific files, or entire project (no `file`)
- `reload`: Restart the language server