#!/usr/bin/env bash
# End-to-end smoke test against the live deployment (run ON the server).
# Verifies auth, RBAC, lead CRUD, webhook HMAC, and dashboard against the real DB.
set -uo pipefail
BASE="http://127.0.0.1:3000"
PASS=0; FAIL=0
ts=$(date +%s)
U="smoke_${ts}"

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS: $1 ($3)"; PASS=$((PASS+1));
  else echo "FAIL: $1 (expected $2, got $3)"; FAIL=$((FAIL+1)); fi
}

# 1. health
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")
check "healthz" 200 "$code"

# 2. register (ADMIN by default)
reg=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"email\":\"$U@example.com\",\"password\":\"password123\",\"passwordConfirmation\":\"password123\"}")
reg_code=$(echo "$reg" | tail -1); reg_body=$(echo "$reg" | sed '$d')
check "register" 201 "$reg_code"
ACCESS=$(echo "$reg_body" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$ACCESS" ] && echo "PASS: got access token" && PASS=$((PASS+1)) || { echo "FAIL: no access token"; FAIL=$((FAIL+1)); }

# 3. duplicate register -> 409
dup=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"email\":\"$U@example.com\",\"password\":\"password123\",\"passwordConfirmation\":\"password123\"}")
check "duplicate register -> 409" 409 "$dup"

# 4. login wrong password -> 401
wl=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"wrongpass1\"}")
check "login wrong pw -> 401" 401 "$wl"

# 5. login correct
lg=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"password123\"}")
ACCESS=$(echo "$lg" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$ACCESS" ] && echo "PASS: login token" && PASS=$((PASS+1)) || { echo "FAIL: login token"; FAIL=$((FAIL+1)); }

# 6. unauthenticated lead list -> 401
ua=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/leads")
check "leads no-auth -> 401" 401 "$ua"

# 7. create lead (ADMIN)
cl=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/leads" -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Lead","phone":"0900000000","source":"website_form","platform":"website","contentPostId":"POST-SMOKE"}')
cl_code=$(echo "$cl" | tail -1); cl_body=$(echo "$cl" | sed '$d')
check "create lead -> 201" 201 "$cl_code"
LEAD_ID=$(echo "$cl_body" | sed -n 's/.*"leadId":"\([^"]*\)".*/\1/p')

# 8. create lead missing contact -> 400
mc=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/leads" -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"name":"NoContact","source":"website_form","platform":"website","contentPostId":"POST-X"}')
check "create lead no-contact -> 400" 400 "$mc"

# 9. list leads
ll=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/leads" -H "Authorization: Bearer $ACCESS")
check "list leads -> 200" 200 "$ll"

# 10. update lead status NEW->CONTACTED
up=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/leads/$LEAD_ID" -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"status":"CONTACTED","note":"called"}')
check "update lead NEW->CONTACTED -> 200" 200 "$up"

# 11. illegal transition CONTACTED->CONVERTED skip -> wait, that's not allowed (must go via QUALIFIED)
il=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/leads/$LEAD_ID" -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"status":"NEW"}')
check "illegal transition CONTACTED->NEW -> 409" 409 "$il"

# 12. webhook bad signature -> 401
ws=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/leads/webhook/website" -H 'Content-Type: application/json' -H 'X-Signature: deadbeef' \
  -d '{"phone":"0911111111","contentPostId":"POST-WH"}')
check "webhook bad signature -> 401" 401 "$ws"

# 13. dashboard overview
dash=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dashboard/overview" -H "Authorization: Bearer $ACCESS")
check "dashboard overview -> 200" 200 "$dash"

echo "================="
echo "SMOKE RESULTS: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_SMOKE_PASSED" || echo "SMOKE_FAILURES_PRESENT"
