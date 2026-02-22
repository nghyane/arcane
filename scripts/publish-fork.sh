#!/bin/bash
set -e

# Publish all public @nghyane packages.
# Usage:
#   bash scripts/publish-fork.sh           Dry run (default)
#   bash scripts/publish-fork.sh --publish Actually publish

PUBLISH=false
if [ "${1:-}" = "--publish" ]; then
  PUBLISH=true
fi

echo "=== Resolving workspace deps ==="
bun scripts/sync-versions.ts

echo ""
echo "=== Publishing ==="
for pkg in packages/*/; do
  if jq -e '.private == true' "$pkg/package.json" > /dev/null 2>&1; then
    continue
  fi
  name=$(jq -r .name "$pkg/package.json")
  echo "Publishing $name..."
  if [ "$PUBLISH" = "false" ]; then
    (cd "$pkg" && bun publish --access public --dry-run 2>&1) || true
  else
    output=$(cd "$pkg" && bun publish --access public 2>&1) && echo "$output" && continue
    echo "$output"
    if echo "$output" | grep -q "previously published\|cannot publish over"; then
      echo "Already published, skipping"
    else
      echo "Failed to publish $name"
      exit 1
    fi
  fi
done

echo ""
echo "Done!"
