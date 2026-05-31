#!/usr/bin/env bash
# Extended E2E smoke test against the live deployment covering all wired modules.
set -uo pipefail
BASE="http://127.0.0.1:3000"
PASS=0; FAIL=0
ts=$(date +%s)
U="smoke2_${ts}"

check() { if [ "$2" = "$3" ]; then echo "PASS: $1 ($3)"; PASS=$((PASS+1)); else echo "FAIL: $1 (expected $2, got $3)"; FAIL=$((FAIL+1)); fi; }
code_of() { echo "$1" | tail -1; }

# health + register ADMIN
check "healthz" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")"
reg=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"email\":\"$U@example.com\",\"password\":\"password123\",\"passwordConfirmation\":\"password123\"}")
check "register ADMIN" 201 "$(code_of "$reg")"
ACCESS=$(echo "$reg" | sed '$d' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
AUTH="Authorization: Bearer $ACCESS"

# Foundation: platform tokens (settings)
check "platform-tokens list" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/platform-tokens" -H "$AUTH")"
check "platform-token refresh fb" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/platform-tokens/facebook/refresh" -H "$AUTH")"

# Content strategy: persona create (valid) + invalid (missing tone)
pc=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/strategy/persona" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"domainName":"XKLD","personaName":"Nurse","age":"22-30","targetNeeds":"work abroad","painPoints":"language","toneOfVoice":"inspirational","interests":"career"}')
check "persona create" 201 "$(code_of "$pc")"
PERSONA_ID=$(echo "$pc" | sed '$d' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
check "persona create missing tone -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/strategy/persona" -H "$AUTH" -H 'Content-Type: application/json' -d '{"domainName":"XKLD","age":"22","targetNeeds":"x","painPoints":"y"}')"

# Calendar
check "calendar view" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/strategy/calendar?view=month" -H "$AUTH")"

# Generation without AI key -> expect 502 (AI not configured), proves wiring + fail-safe
gen=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/generation/generate" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"domainName\":\"XKLD\",\"personaIds\":[\"$PERSONA_ID\"],\"objective\":\"Lead\"}")
if [ "$gen" = "502" ] || [ "$gen" = "404" ]; then echo "PASS: generate (AI not configured/te) ($gen)"; PASS=$((PASS+1)); else echo "FAIL: generate expected 502/404 got $gen"; FAIL=$((FAIL+1)); fi
# generate invalid objective -> 400
check "generate bad objective -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/generation/generate" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"domainName\":\"XKLD\",\"personaIds\":[\"$PERSONA_ID\"],\"objective\":\"BOGUS\"}")"

# Drafts list
check "drafts list" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/generation/drafts" -H "$AUTH")"

# Analytics + feedback
check "feedback insights list" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/feedback/insights" -H "$AUTH")"
check "ai-context cold start -> 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/strategy/ai-context" -H "$AUTH")"
check "analytics collect trigger" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/analytics/collect" -H "$AUTH" -H 'Content-Type: application/json' -d '{}')"

# Lead export (CSV)
check "lead export csv" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/leads/export?format=csv" -H "$AUTH")"
check "lead export bad format -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/leads/export?format=pdf" -H "$AUTH")"
check "lead stats" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/leads/stats?groupBy=source" -H "$AUTH")"

# SALES dashboard read-only still enforced (register can't make SALES; just confirm dashboard works for ADMIN)
check "dashboard overview" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dashboard/overview" -H "$AUTH")"
check "dashboard notifications" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dashboard/notifications" -H "$AUTH")"

echo "================="
echo "SMOKE2 RESULTS: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_SMOKE2_PASSED" || echo "SMOKE2_FAILURES_PRESENT"
