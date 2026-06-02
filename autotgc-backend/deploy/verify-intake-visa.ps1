# Verify the omni-channel intake / partners / visa deploy on the server.
# Password comes ONLY from $env:DEPLOY_PASSWORD (never written to disk).
param([string]$ServerHost = '36.50.26.118')
$ErrorActionPreference = 'Continue'
Import-Module Posh-SSH -ErrorAction Stop
if (-not $env:DEPLOY_PASSWORD) { throw 'DEPLOY_PASSWORD env var is not set' }
$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)
$s = New-SSHSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60

# Build the remote bash script (here-string so && is safe).
$bash = @'
set -uo pipefail
echo "=== ROUTE REGISTRATION (expect 401 = registered behind auth, NOT 404) ==="
echo "PARTNERS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/partners)"
echo "DESTINATIONS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/destinations)"
echo "VISA_CASES=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/visa-cases)"
echo "VISA_CASES_GET=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/visa-cases)"
echo "VISA_POST=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:3000/api/v1/visa-cases)"
echo "VISA_ADVICE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/visa-cases/x/advice)"
echo "INTAKE_CONVOS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/v1/intake/conversations)"
echo "ZALO_WEBHOOK_NOSIG=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:3000/api/intake/webhook/zalo)"
echo "=== NEW TABLES ON PG16 ==="
printf 'SELECT 1 FROM "DestinationProgram" LIMIT 1;\n' > /tmp/dp.sql
printf 'SELECT 1 FROM "IntakeConversation" LIMIT 1;\n' > /tmp/ic.sql
printf 'SELECT 1 FROM "VisaCase" LIMIT 1;\n' > /tmp/vc.sql
printf 'SELECT 1 FROM "PartnerOrg" LIMIT 1;\n' > /tmp/po.sql
chown autotgc:autotgc /tmp/dp.sql /tmp/ic.sql /tmp/vc.sql /tmp/po.sql
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/po.sql && echo PARTNERORG_OK' 2>&1 | tail -1
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/dp.sql && echo DESTINATIONPROGRAM_OK' 2>&1 | tail -1
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/ic.sql && echo INTAKECONVERSATION_OK' 2>&1 | tail -1
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/vc.sql && echo VISACASE_OK' 2>&1 | tail -1
rm -f /tmp/dp.sql /tmp/ic.sql /tmp/vc.sql /tmp/po.sql
'@
$bash = $bash -replace "`r`n", "`n"
$r = Invoke-SSHCommand -SessionId $s.SessionId -Command $bash -TimeOut 180
$r.Output | ForEach-Object { Write-Host $_ }
if ($r.Error) { $r.Error | ForEach-Object { Write-Host "ERR: $_" } }
Remove-SSHSession -SessionId $s.SessionId | Out-Null
