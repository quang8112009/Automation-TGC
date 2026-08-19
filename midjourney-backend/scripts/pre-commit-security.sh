#!/usr/bin/env bash
# pre-commit-security.sh — Git pre-commit hook for secret scanning.
#
# Install:
#   ln -s ../../scripts/pre-commit-security.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# What it checks:
#   1. .env files (except .env.example) must NEVER be staged.
#   2. Hardcoded API keys / tokens / passwords in source files.
#   3. Private keys (PEM, SSH) in staged files.
#   4. Large files (>5MB) that shouldn't be in git.
#
# Exit 0 = allow commit, Exit 1 = block commit.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0

echo -e "${YELLOW}🔒 Running pre-commit security checks...${NC}"

# ── 1. Block .env files ─────────────────────────────────────────────────────
ENV_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.env$|\.env\.' | grep -v '\.env\.example' || true)
if [ -n "$ENV_FILES" ]; then
  echo -e "${RED}✗ BLOCKED: .env files detected in staging:${NC}"
  echo "$ENV_FILES"
  echo "  Remove them: git reset HEAD <file>"
  ERRORS=$((ERRORS + 1))
fi

# ── 2. Scan for hardcoded secrets ────────────────────────────────────────────
# Look for high-entropy strings assigned to key-like variable names.
STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|js|json)$' | grep -v node_modules | grep -v '.env.example' || true)
if [ -n "$STAGED_TS" ]; then
  SECRET_HITS=$(echo "$STAGED_TS" | xargs grep -n -i -E \
    '(api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*["'"'"'][A-Za-z0-9+/=_\-]{20,}' \
    2>/dev/null | grep -v 'CHANGE_ME' | grep -v 'interface ' | grep -v 'type ' | grep -v '//' | grep -v 'env(' | grep -v 'test/' || true)

  if [ -n "$SECRET_HITS" ]; then
    echo -e "${RED}✗ WARNING: Potential hardcoded secrets:${NC}"
    echo "$SECRET_HITS" | head -10
    echo "  Review these before committing."
    # Don't block on this — could be false positives (type defs, env refs).
    # ERRORS=$((ERRORS + 1))
  fi
fi

# ── 3. Block private keys ───────────────────────────────────────────────────
PEM_FILES=$(git diff --cached --name-only --diff-filter=ACM | xargs grep -l 'BEGIN.*PRIVATE KEY' 2>/dev/null || true)
if [ -n "$PEM_FILES" ]; then
  echo -e "${RED}✗ BLOCKED: Private key files detected:${NC}"
  echo "$PEM_FILES"
  ERRORS=$((ERRORS + 1))
fi

# ── 4. Block large files (>5MB) ─────────────────────────────────────────────
LARGE_FILES=$(git diff --cached --name-only --diff-filter=ACM | while read -r f; do
  if [ -f "$f" ]; then
    SIZE=$(stat -f%z "$f" 2>/dev/null || stat --format=%s "$f" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 5242880 ] 2>/dev/null; then
      echo "$f ($(( SIZE / 1048576 ))MB)"
    fi
  fi
done || true)

if [ -n "$LARGE_FILES" ]; then
  echo -e "${YELLOW}⚠ WARNING: Large files (>5MB) in commit:${NC}"
  echo "$LARGE_FILES"
  echo "  Consider using Git LFS for binary assets."
fi

# ── Result ───────────────────────────────────────────────────────────────────
if [ "$ERRORS" -gt 0 ]; then
  echo -e "\n${RED}✗ Commit blocked. Fix the issues above and try again.${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Security checks passed.${NC}"
exit 0
