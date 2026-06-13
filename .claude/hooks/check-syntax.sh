#!/bin/bash
# Fail open — if jq is missing, don't block edits
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

# Only check .ts files (not .js, .json, .md, etc.)
if [[ -z "$file_path" || "$file_path" != *.ts ]]; then
  exit 0
fi

# File must exist
if [[ ! -f "$file_path" ]]; then
  exit 0
fi

# Run a project-wide typecheck — catches type errors introduced by the edit
# Runs from project root regardless of which file was edited
project_root="$(git -C "$(dirname "$file_path")" rev-parse --show-toplevel 2>/dev/null || dirname "$file_path")"

echo "Checking TypeScript: $file_path"
cd "$project_root" && npx tsc --noEmit 2>&1
