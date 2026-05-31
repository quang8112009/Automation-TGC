#!/usr/bin/env bash
# Analytics smoke: register fresh ADMIN, capture token, hit the 4 candidate
# analytics endpoints (the new FE page's data source), print codes + funnel JSON,
# then verify the SPA through nginx :8088 (/ , /analytics deep-link, asset served).
set -uo pipefail
BASE="http://127.0.0.1:3000"
NGINX="http://127.0.0.1:8088"
ts=$(date +%s)
U="ansmoke_${ts}"

echo "HEALTHZ=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")"
echo "READYZ_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/readyz")"
echo "READYZ_BODY=$(curl -s "$BASE/readyz")"
echo "API_V1=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1")"

reg=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"email\":\"$U@example.com\",\"password\":\"password123\",\"passwordConfirmation\":\"password123\"}")
REG_CODE=$(echo "$reg" | tail -1)
echo "REGISTER_ADMIN=$REG_CODE"
ACCESS=$(echo "$reg" | sed '$d' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
AUTH="Authorization: Bearer $ACCESS"

echo "--- ANALYTICS ENDPOINTS (codes) ---"
echo "FUNNEL=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/candidates/analytics/funnel" -H "$AUTH")"
echo "BY_MARKET=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/candidates/analytics/by-market" -H "$AUTH")"
echo "BY_SOURCE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/candidates/analytics/by-source" -H "$AUTH")"
echo "CONV_BY_JOB_ORDER=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/candidates/analytics/conversion-by-job-order" -H "$AUTH")"

echo "--- FUNNEL JSON ---"
curl -s "$BASE/api/v1/candidates/analytics/funnel" -H "$AUTH"
echo ""

echo "--- NGINX :8088 SPA ---"
echo "NGINX_ROOT=$(curl -s -o /dev/null -w '%{http_code}' "$NGINX/")"
echo "NGINX_ANALYTICS=$(curl -s -o /dev/null -w '%{http_code}' "$NGINX/analytics")"
echo "--- /analytics body asset marker (should serve index.html) ---"
curl -s "$NGINX/analytics" | grep -oE '/assets/index-[A-Za-z0-9_-]*\.js|<div id="root"></div>' | head
echo "--- asset fetch code ---"
ASSET=$(curl -s "$NGINX/" | grep -oE '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)
echo "ASSET_PATH=$ASSET"
echo "ASSET_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$NGINX$ASSET")"
echo "ANALYTICS_SMOKE_DONE"
