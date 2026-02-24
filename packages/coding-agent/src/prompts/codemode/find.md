# Find

Glob-based file discovery.
- Pattern includes search path: `src/**/*.ts`, `lib/*.json`, `**/*.md`
- Simple patterns like `*.ts` search recursively from cwd
- Results sorted by modification time (most recent first), truncated at 1000
