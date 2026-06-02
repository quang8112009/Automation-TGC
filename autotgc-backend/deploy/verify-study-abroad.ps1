# Verify the study-abroad enhancements deploy on the server.
param([string]$ServerHost = '36.50.26.118')
$ErrorActionPreference = 'Continue'
Import-Module Posh-SSH -ErrorAction Stop
if (-not $env:DEPLOY_PASSWORD) { throw 'DEPLOY_PASSWORD env var is not set' }
$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)
$s = New-SSHSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60

$bash = @'
set -uo pipefail
echo "=== ROUTES (expect 401 = registered behind auth, NOT 404) ==="
echo "DOC_EXTRACTIONS_POST=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:3000/api/v1/doc-extractions)"
echo "SCHOLARSHIP_POST=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:3000/api/v1/scholarship-suggestions)"
echo "FOLLOWUPS_GET=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/follow-ups)"
echo "FOLLOWUPS_SCAN=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/v1/follow-ups/scan)"
echo "=== SPA ROUTES ==="
echo "SPA_FOLLOWUPS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8088/follow-ups)"
echo "=== NEW TABLES + COLUMNS ON PG16 ==="
printf 'SELECT 1 FROM "DocumentExtraction" LIMIT 1;\n' > /tmp/de.sql
printf 'SELECT 1 FROM "FollowUpTask" LIMIT 1;\n' > /tmp/ft.sql
printf 'SELECT "tuitionPerYearVndM","scholarshipMaxPct","minGpa","minIelts" FROM "DestinationProgram" LIMIT 1;\n' > /tmp/dp.sql
chown autotgc:autotgc /tmp/de.sql /tmp/ft.sql /tmp/dp.sql
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/de.sql && echo DOCUMENTEXTRACTION_OK' 2>&1 | tail -1
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/ft.sql && echo FOLLOWUPTASK_OK' 2>&1 | tail -1
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/dp.sql && echo DESTINATION_FINANCE_COLS_OK' 2>&1 | tail -1
rm -f /tmp/de.sql /tmp/ft.sql /tmp/dp.sql
'@
$bash = $bash -replace "`r`n", "`n"
$r = Invoke-SSHCommand -SessionId $s.SessionId -Command $bash -TimeOut 180
$r.Output | ForEach-Object { Write-Host $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Host "ERR: $_" } }
Remove-SSHSession -SessionId $s.SessionId | Out-Null
