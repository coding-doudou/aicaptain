#!/usr/bin/env bash
# Replace MDP scaffold app in aicaptains-service with this quiz repo (same layout as Maersk-Global/aicaptain).
# Usage (from anywhere):
#   ./scripts/integrate-into-aicaptains-service.sh /path/to/aicaptains-service
#
# Prerequisites: clone Maersk-Global/aicaptains-service first; run this from the aicaptain (Captains Quizz) repo.

set -euo pipefail
QUIZ_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?Usage: $0 /path/to/aicaptains-service}"

if [[ ! -d "$TARGET/.git" ]]; then
  echo "error: not a git repository: $TARGET" >&2
  exit 1
fi

echo "Quiz source: $QUIZ_ROOT"
echo "Target MDP repo: $TARGET"
echo ""

# Backup scaffold app source (do not touch .github until you verify workflows)
if [[ -d "$TARGET/src" ]]; then
  BAK="$TARGET/src.scaffold.bak.$(date +%s)"
  mv "$TARGET/src" "$BAK"
  echo "Moved scaffold src/ -> $BAK"
fi

for f in Dockerfile .dockerignore package.json package-lock.json aicaptain.html; do
  if [[ ! -f "$QUIZ_ROOT/$f" ]]; then
    echo "error: missing $QUIZ_ROOT/$f" >&2
    exit 1
  fi
  cp "$QUIZ_ROOT/$f" "$TARGET/$f"
  echo "Copied $f"
done

rm -rf "$TARGET/server"
cp -R "$QUIZ_ROOT/server" "$TARGET/server"
echo "Copied server/"

echo ""
echo "Done. Next steps:"
echo "  1. cd \"$TARGET\""
echo "  2. grep -R Dockerfile .github 2>/dev/null || true"
echo "  3. Ensure workflow builds from repo root (docker build .) and tags match MDP regex ^dev-.+"
echo "  4. git status && git add -A && git commit -m \"Replace scaffold with AI Captains quiz\" && git push"
echo "  5. Bump MDP service memory to 256MB+ if Node OOMs."
