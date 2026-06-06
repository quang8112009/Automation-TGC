# Post-deploy verification for study-abroad-ai-advisor-suite.
# Confirms new routes are registered (401 unauthenticated, NOT 404) and the
# new tables exist. Uses the ACTUAL registered paths/methods. Password from
# $env:DEPLOY_PASSWORD only.
param([string]$ServerHost = '36.50.26.118')

$ErrorActionPreference = 'Continue'
Import-Module Posh-SSH -ErrorAction Stop
if (-not $env:DEPLOY_PASSWORD) { throw 'DEPLOY_PASSWORD env var is not set' }
$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)

$ssh = New-SSHSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
function Run([string]$cmd, [int]$timeout = 120) {
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut $timeout
  if ($r.Output) { $r.Output | ForEach-Object { Write-Host $_ } }
  if ($r.Error)  { $r.Error  | ForEach-Object { Write-Host "ERR: $_" } }
}
try {
  Write-Host '========== NEW ROUTES (expect 401 unauth, not 404) =========='
  Run 'P=_probe ; B=http://127.0.0.1:3000/api/v1/candidates ; echo "ADMISSIONS_SCORE=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/$P/admissions/score)" ; echo "ESSAYS_LIST=$(curl -s -o /dev/null -w "%{http_code}" $B/$P/essays)" ; echo "INTERVIEW_SESSIONS=$(curl -s -o /dev/null -w "%{http_code}" $B/$P/interview-sessions)" ; echo "APPLICATIONS_LIST=$(curl -s -o /dev/null -w "%{http_code}" $B/$P/applications)" ; echo "ROADMAP_POST=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/$P/roadmap)" ; echo "ROADMAP_READINESS=$(curl -s -o /dev/null -w "%{http_code}" $B/$P/roadmap/readiness)"'

  Write-Host '========== NEW TABLES EXIST =========='
  $dbScript = @'
set -uo pipefail
WD=/opt/autotgc
for T in AcademicProfile EssayDraft InterviewSession ApplicationCase ApplicationDueItem ReminderLog RoadmapNarrative; do
  F="${WD}/.chk_${T}.sql"
  printf 'SELECT 1 FROM "%s" LIMIT 1;\n' "$T" > "$F"
  chown autotgc:autotgc "$F"
  if sudo -u autotgc bash -lc "cd ${WD} && npx prisma db execute --schema prisma/schema.prisma --file ${F}" >/dev/null 2>&1; then
    echo "TABLE_OK=${T}"
  else
    echo "TABLE_MISSING=${T}"
  fi
  rm -f "$F"
done
'@
  $dbScript = $dbScript -replace "`r`n", "`n"
  Run $dbScript 180

  Write-Host '========== NEW COLUMNS on DestinationProgram =========='
  $colScript = @'
set -uo pipefail
WD=/opt/autotgc
F="${WD}/.chk_cols.sql"
printf 'SELECT "minToefl","minJlpt","selectivityTier" FROM "DestinationProgram" LIMIT 1;\n' > "$F"
chown autotgc:autotgc "$F"
if sudo -u autotgc bash -lc "cd ${WD} && npx prisma db execute --schema prisma/schema.prisma --file ${F}" >/dev/null 2>&1; then
  echo "COLUMNS_OK=minToefl,minJlpt,selectivityTier"
else
  echo "COLUMNS_MISSING"
fi
rm -f "$F"
'@
  $colScript = $colScript -replace "`r`n", "`n"
  Run $colScript 120

  Write-Host '========== SCHEDULED JOB (study-timeline-sweep) =========='
  Run 'grep -ho "study-timeline-sweep" /var/log/autotgc/out*.log 2>/dev/null | sort -u | head'
}
finally {
  if ($ssh) { Remove-SSHSession -SessionId $ssh.SessionId | Out-Null }
  Write-Host 'Session closed.'
}
