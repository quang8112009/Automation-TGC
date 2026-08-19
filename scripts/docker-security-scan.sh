#!/usr/bin/env bash
# docker-security-scan.sh — Local Docker security scanning with Trivy.
#
# USAGE:
#   bash scripts/docker-security-scan.sh              # Scan all images
#   bash scripts/docker-security-scan.sh backend       # Scan backend only
#   bash scripts/docker-security-scan.sh frontend      # Scan frontend only
#   bash scripts/docker-security-scan.sh config        # Scan IaC configs
#   bash scripts/docker-security-scan.sh fs            # Scan filesystem
#
# PREREQUISITES:
#   - Docker installed and running
#   - Trivy installed: brew install trivy (macOS) or apt install trivy (Linux)
#   - OR use Docker: docker run --rm aquasec/trivy:latest
#
# EXIT CODES:
#   0 = no vulnerabilities found
#   1 = critical or high vulnerabilities found

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCAN_TARGET="${1:-all}"
SEVERITY="CRITICAL,HIGH"
EXIT_CODE=0

echo -e "${BLUE}🔒 AutoTGC Docker Security Scan${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if Trivy is installed.
if ! command -v trivy &> /dev/null; then
  echo -e "${YELLOW}⚠ Trivy not found locally. Using Docker to run Trivy...${NC}"
  TRIVY_CMD="docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest"
else
  TRIVY_CMD="trivy"
fi

# ── Build images ─────────────────────────────────────────────────────────────

build_image() {
  local name=$1
  local context=$2

  echo -e "${BLUE}Building ${name} image...${NC}"
  if docker build -t "autotgc-${name}:scan" "${context}" 2>/dev/null; then
    echo -e "${GREEN}✓ ${name} image built successfully${NC}"
    return 0
  else
    echo -e "${RED}✗ Failed to build ${name} image${NC}"
    return 1
  fi
}

# ── Scan functions ───────────────────────────────────────────────────────────

scan_image() {
  local name=$1
  local image="autotgc-${name}:scan"

  echo ""
  echo -e "${BLUE}── Scanning ${name} image ──${NC}"

  if ! docker image inspect "${image}" &>/dev/null; then
    echo -e "${YELLOW}Image ${image} not found. Building...${NC}"
    build_image "${name}" "./midjourney-${name}" || return 1
  fi

  echo -e "Scanning for ${SEVERITY} vulnerabilities..."
  if ${TRIVY_CMD} image \
    --severity "${SEVERITY}" \
    --exit-code 1 \
    --no-progress \
    --format table \
    "${image}" 2>/dev/null; then
    echo -e "${GREEN}✓ ${name}: No critical/high vulnerabilities found${NC}"
  else
    echo -e "${RED}✗ ${name}: Critical/high vulnerabilities detected${NC}"
    EXIT_CODE=1
  fi
}

scan_config() {
  echo ""
  echo -e "${BLUE}── Scanning IaC configurations ──${NC}"

  if ${TRIVY_CMD} config \
    --severity "${SEVERITY}" \
    --exit-code 1 \
    --no-progress \
    --format table \
    . 2>/dev/null; then
    echo -e "${GREEN}✓ Config: No critical/high misconfigurations found${NC}"
  else
    echo -e "${RED}✗ Config: Critical/high misconfigurations detected${NC}"
    EXIT_CODE=1
  fi
}

scan_filesystem() {
  echo ""
  echo -e "${BLUE}── Scanning filesystem (secrets + dependencies) ──${NC}"

  if ${TRIVY_CMD} fs \
    --severity "${SEVERITY}" \
    --exit-code 1 \
    --no-progress \
    --format table \
    --skip-dirs node_modules \
    --skip-dirs dist \
    --skip-dirs test \
    --skip-dirs .git \
    . 2>/dev/null; then
    echo -e "${GREEN}✓ Filesystem: No critical/high issues found${NC}"
  else
    echo -e "${RED}✗ Filesystem: Critical/high issues detected${NC}"
    EXIT_CODE=1
  fi
}

# ── Run scans ────────────────────────────────────────────────────────────────

case "${SCAN_TARGET}" in
  backend)
    build_image backend ./midjourney-backend
    scan_image backend
    ;;
  frontend)
    build_image frontend ./midjourney-frontend
    scan_image frontend
    ;;
  config)
    scan_config
    ;;
  fs)
    scan_filesystem
    ;;
  all)
    build_image backend ./midjourney-backend
    build_image frontend ./midjourney-frontend
    scan_image backend
    scan_image frontend
    scan_config
    scan_filesystem
    ;;
  *)
    echo -e "${RED}Unknown target: ${SCAN_TARGET}${NC}"
    echo "Usage: $0 [backend|frontend|config|fs|all]"
    exit 1
    ;;
esac

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
if [ "${EXIT_CODE}" -eq 0 ]; then
  echo -e "${GREEN}✓ All scans passed. No critical/high vulnerabilities.${NC}"
else
  echo -e "${RED}✗ Vulnerabilities found. Review the output above.${NC}"
  echo -e "${YELLOW}  Run 'trivy image autotgc-backend:scan --severity CRITICAL,HIGH' for details.${NC}"
fi
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"

exit "${EXIT_CODE}"
