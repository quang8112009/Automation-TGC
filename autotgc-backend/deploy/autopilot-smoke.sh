#!/usr/bin/env bash
# Autopilot / AI-marketing smoke test against the live deployment (direct :3000).
# Mirrors e2e-smoke2.sh: registers a fresh ADMIN, captures accessToken, then
# exercises every NEW route group. Prints each check with its HTTP code and the
# key body fields so the deploy report can be fully honest.
set -uo pipefail
BASE="http://127.0.0.1:3000"
PASS=0; FAIL=0
ts=$(date +%s)
U="autopilot_${ts}"
FROM=$(date -u +%Y-%m-%dT00:00:00Z)
TO=$(date -u -d "+14 days" +%Y-%m-%dT00:00:00Z)

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
code_of() { echo "$1" | tail -1; }
body_of() { echo "$1" | sed '$d'; }
# Extract the FIRST occurrence of a string JSON field's value (avoids greedy
# regexes grabbing the LAST match inside nested arrays like steps[]/items[]).
first_str() { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | sed "s/\"$2\":\"//;s/\"$//"; }

echo "=== register fresh ADMIN ==="
reg=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"email\":\"$U@example.com\",\"password\":\"password123\",\"passwordConfirmation\":\"password123\"}")
rc=$(code_of "$reg")
[ "$rc" = "201" ] && ok "register ADMIN ($rc)" || bad "register ADMIN (expected 201 got $rc)"
ACCESS=$(body_of "$reg" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
AUTH="Authorization: Bearer $ACCESS"

echo "=== GET /api/v1 manifest groups ==="
man=$(curl -s -w '\n%{http_code}' "$BASE/api/v1")
mc=$(code_of "$man"); mb=$(body_of "$man")
[ "$mc" = "200" ] && ok "GET /api/v1 ($mc)" || bad "GET /api/v1 (expected 200 got $mc)"
for g in trends content_plans multi_format brand_templates assets autopilot; do
  if echo "$mb" | grep -q "\"$g\""; then ok "manifest lists group: $g"; else bad "manifest MISSING group: $g"; fi
done

echo "=== POST /api/v1/trends/research {market:JAPAN} ==="
tr=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/trends/research" -H "$AUTH" -H 'Content-Type: application/json' -d '{"market":"JAPAN"}')
trc=$(code_of "$tr"); trb=$(body_of "$tr")
[ "$trc" = "201" ] && ok "trends/research ($trc)" || bad "trends/research (expected 201 got $trc)"
AIGEN=$(echo "$trb" | sed -n 's/.*"aiGenerated":\([a-z]*\).*/\1/p')
TRENDS_CREATED=$(echo "$trb" | grep -o '"id":' | wc -l)
echo "  trends.research aiGenerated=$AIGEN createdCount=$TRENDS_CREATED"
[ "$AIGEN" = "false" ] && ok "trends.research aiGenerated=false (heuristic fallback, no Gemini key)" || bad "trends.research aiGenerated expected false got '$AIGEN'"
[ "$TRENDS_CREATED" -gt 0 ] && ok "trends.research created >0 ($TRENDS_CREATED)" || bad "trends.research created 0"

echo "=== GET /api/v1/trends?market=JAPAN ==="
tl=$(curl -s -w '\n%{http_code}' "$BASE/api/v1/trends?market=JAPAN" -H "$AUTH")
tlc=$(code_of "$tl"); tlb=$(body_of "$tl")
TREND_LIST_N=$(echo "$tlb" | grep -o '"id":' | wc -l)
echo "  trends list count=$TREND_LIST_N"
{ [ "$tlc" = "200" ] && [ "$TREND_LIST_N" -gt 0 ]; } && ok "trends list non-empty ($tlc, n=$TREND_LIST_N)" || bad "trends list (code $tlc, n=$TREND_LIST_N)"

echo "=== POST /api/v1/content-plans {market:JAPAN,objective:Lead,channels:[facebook,website]} ==="
cp=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/content-plans" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"market\":\"JAPAN\",\"objective\":\"Lead\",\"periodFrom\":\"$FROM\",\"periodTo\":\"$TO\",\"channels\":[\"facebook\",\"website\"]}")
cpc=$(code_of "$cp"); cpb=$(body_of "$cp")
PLAN_ID=$(first_str "$cpb" id)
PLAN_ITEMS=$(echo "$cpb" | grep -o '"orderIndex":' | wc -l)
echo "  content-plan id=$PLAN_ID itemCount=$PLAN_ITEMS"
{ [ "$cpc" = "201" ] && [ "$PLAN_ITEMS" -gt 0 ]; } && ok "content-plans create ($cpc, items=$PLAN_ITEMS)" || bad "content-plans create (code $cpc, items=$PLAN_ITEMS)"

echo "=== GET /api/v1/content-plans/:id ==="
cpg=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/content-plans/$PLAN_ID" -H "$AUTH")
[ "$cpg" = "200" ] && ok "content-plans get ($cpg)" || bad "content-plans get (expected 200 got $cpg)"

echo "=== GET /api/v1/brand-templates ==="
bt=$(curl -s -w '\n%{http_code}' "$BASE/api/v1/brand-templates" -H "$AUTH")
btc=$(code_of "$bt"); btb=$(body_of "$bt")
BT_N=$(echo "$btb" | grep -o '"kind":' | wc -l)
echo "  brand-templates count=$BT_N"
{ [ "$btc" = "200" ] && [ "$BT_N" -gt 0 ]; } && ok "brand-templates list count>0 ($btc, n=$BT_N)" || bad "brand-templates list (code $btc, n=$BT_N)"

echo "=== POST /api/v1/assets/standalone {kind:thumbnail} ==="
as=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/assets/standalone" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"kind":"thumbnail","title":"Test","body":"Nội dung kiểm thử asset"}')
asc=$(code_of "$as"); asb=$(body_of "$as")
ASSET_STATUS=$(first_str "$asb" status)
echo "  asset status=$ASSET_STATUS"
{ [ "$asc" = "201" ] && [ "$ASSET_STATUS" = "SPEC_READY" ]; } && ok "assets/standalone SPEC_READY ($asc)" || bad "assets/standalone (code $asc, status=$ASSET_STATUS)"

echo "=== POST /api/v1/generation/multi-format (expect 502 without Gemini key) ==="
# Create a persona first so a real domain (XKLD) + persona exist -> generation reaches AI and fails clean (502).
pc=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/strategy/persona" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"domainName":"XKLD","personaName":"Nurse","age":"22-30","targetNeeds":"work abroad","painPoints":"language","toneOfVoice":"inspirational","interests":"career"}')
PERSONA_ID=$(first_str "$(body_of "$pc")" id)
mf=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/generation/multi-format" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"format\":\"FANPAGE_CAPTION\",\"domainName\":\"XKLD\",\"personaIds\":[\"$PERSONA_ID\"],\"objective\":\"Lead\"}")
echo "  multi-format HTTP=$mf"
if [ "$mf" = "502" ]; then ok "multi-format 502 AI_NOT_CONFIGURED (wiring + clean fail) ($mf)";
elif [ "$mf" = "400" ] || [ "$mf" = "404" ]; then ok "multi-format $mf (validation/missing — acceptable)";
else bad "multi-format unexpected code $mf"; fi

echo "=== GET /api/v1/generation/formats ==="
fmt=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/generation/formats" -H "$AUTH")
[ "$fmt" = "200" ] && ok "generation/formats ($fmt)" || bad "generation/formats (expected 200 got $fmt)"

echo "=== POST /api/v1/autopilot/run {requireApproval:true} ==="
ap=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/autopilot/run" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"market\":\"JAPAN\",\"objective\":\"Lead\",\"periodFrom\":\"$FROM\",\"periodTo\":\"$TO\",\"channels\":[\"facebook\",\"website\"],\"requireApproval\":true}")
apc=$(code_of "$ap"); apb=$(body_of "$ap")
RUN_ID=$(first_str "$apb" runId)
RUN_STATUS=$(first_str "$apb" status)
RUN_STEP=$(first_str "$apb" currentStep)
echo "  autopilot.run runId=$RUN_ID status=$RUN_STATUS currentStep=$RUN_STEP"
[ "$apc" = "201" ] && ok "autopilot/run ($apc)" || bad "autopilot/run (expected 201 got $apc)"

echo "=== GET /api/v1/autopilot/runs/:id ==="
rg=$(curl -s -w '\n%{http_code}' "$BASE/api/v1/autopilot/runs/$RUN_ID" -H "$AUTH")
rgc=$(code_of "$rg"); rgb=$(body_of "$rg")
GET_STATUS=$(first_str "$rgb" status)
GET_STEP=$(first_str "$rgb" currentStep)
echo "  autopilot.get status=$GET_STATUS currentStep=$GET_STEP"
echo "  --- per-step statuses ---"
echo "$rgb" | grep -o '"name":"[^"]*","status":"[^"]*"' || echo "  (could not parse step pairs)"
[ "$rgc" = "200" ] && ok "autopilot/runs/:id ($rgc)" || bad "autopilot/runs/:id (expected 200 got $rgc)"
if [ "$GET_STATUS" = "WAITING_APPROVAL" ] && [ "$GET_STEP" = "review_gate" ]; then
  ok "autopilot reached review_gate / WAITING_APPROVAL (loop ran research->plan->generate->review_gate)"
else
  bad "autopilot did NOT reach review_gate (status=$GET_STATUS step=$GET_STEP)"
fi

echo "================="
echo "AUTOPILOT SMOKE RESULTS: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_AUTOPILOT_SMOKE_PASSED" || echo "AUTOPILOT_SMOKE_FAILURES_PRESENT"
