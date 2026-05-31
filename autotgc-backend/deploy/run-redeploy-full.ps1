# Full redeploy: AutoTGC backend + new frontend SPA, via Posh-SSH.
# Password comes ONLY from $env:DEPLOY_PASSWORD (never written to disk).
# Run from anywhere. Prints clearly-delimited sections for each phase.
param(
  [string]$ServerHost = '36.50.26.118',
  [string]$BeTar = 'C:\Users\PC\Documents\docs\autotgc.tar.gz',
  [string]$FeTar = 'C:\Users\PC\Documents\docs\autotgc-frontend-dist.tar.gz'
)

$ErrorActionPreference = 'Continue'
Import-Module Posh-SSH -ErrorAction Stop

if (-not $env:DEPLOY_PASSWORD) { throw 'DEPLOY_PASSWORD env var is not set' }
$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)

function Section([string]$t) { Write-Host "`n========== $t ==========" }

# Run a command, print output+error, return the result object. Does NOT throw on non-zero.
function Run([string]$cmd, [int]$timeout = 300) {
  $r = Invoke-SSHCommand -SessionId $script:ssh.SessionId -Command $cmd -TimeOut $timeout
  if ($r.Output) { $r.Output | ForEach-Object { Write-Host $_ } }
  if ($r.Error)  { $r.Error  | ForEach-Object { Write-Host "ERR: $_" } }
  return $r
}

Section 'OPEN SESSIONS'
$script:ssh  = New-SSHSession  -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
$script:sftp = New-SFTPSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
Write-Host "SSH session:  $($script:ssh.SessionId)  connected=$($script:ssh.Connected)"
Write-Host "SFTP session: $($script:sftp.SessionId) connected=$($script:sftp.Connected)"

try {
  Section 'UPLOAD TARBALLS'
  Set-SFTPItem -SessionId $script:sftp.SessionId -Path $BeTar -Destination '/tmp' -Force
  Set-SFTPItem -SessionId $script:sftp.SessionId -Path $FeTar -Destination '/tmp' -Force
  Run 'ls -la /tmp/autotgc.tar.gz /tmp/autotgc-frontend-dist.tar.gz'

  Section 'EXTRACT BACKEND SOURCE'
  Run 'rm -rf /opt/autotgc-src/* ; mkdir -p /opt/autotgc-src ; tar -xzf /tmp/autotgc.tar.gz -C /opt/autotgc-src --strip-components=1 ; echo "--- src top ---" ; ls /opt/autotgc-src ; echo "--- deploy dir ---" ; ls /opt/autotgc-src/deploy | head'

  Section 'RUN redeploy2.sh (nohup + poll)'
  Run 'rm -f /tmp/redeploy.log ; nohup bash /opt/autotgc-src/deploy/redeploy2.sh > /tmp/redeploy.log 2>&1 & echo "LAUNCHED_PID=$!"'
  $deadline = (Get-Date).AddMinutes(25)
  $done = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 15
    $chk = Invoke-SSHCommand -SessionId $script:ssh.SessionId -Command 'grep -q "^DONE$" /tmp/redeploy.log && echo READY || echo WAIT' -TimeOut 60
    $state = ($chk.Output | Select-Object -Last 1)
    Write-Host ("poll {0} -> {1}" -f (Get-Date -Format HH:mm:ss), $state)
    if ($state -eq 'READY') { $done = $true; break }
  }
  Section 'redeploy2.sh FULL OUTPUT'
  Run 'cat /tmp/redeploy.log'
  if (-not $done) { Write-Host '!!! redeploy did not reach DONE within timeout !!!' }

  Section 'DEPLOY FRONTEND DIST'
  Run 'mkdir -p /opt/autotgc-frontend ; rm -rf /opt/autotgc-frontend/dist ; tar -xzf /tmp/autotgc-frontend-dist.tar.gz -C /opt/autotgc-frontend ; chown -R autotgc:autotgc /opt/autotgc-frontend ; echo "--- dist ---" ; ls -la /opt/autotgc-frontend/dist ; ls -la /opt/autotgc-frontend/dist/assets'

  Section 'INSTALL NGINX VHOST (locate, backup, overwrite, test, reload/restore)'
  $nginxScript = @'
set -uo pipefail
VHOST=$(grep -rl 'listen 8088' /www/server/panel/vhost/nginx/ /www/server/nginx/conf/ 2>/dev/null | head -1)
echo "FOUND_VHOST=${VHOST}"
if [ -z "${VHOST}" ]; then echo "NO_VHOST_FOUND_ON_8088"; exit 0; fi
BAK="${VHOST}.bak.$(date +%s)"
cp "${VHOST}" "${BAK}"
echo "BACKED_UP_TO=${BAK}"
cp /opt/autotgc-src/deploy/panel-vhost.conf "${VHOST}"
echo "OVERWROTE=${VHOST}"
NGINX=/www/server/nginx/sbin/nginx
[ -x "${NGINX}" ] || NGINX=nginx
echo "NGINX_BIN=${NGINX}"
if ${NGINX} -t > /tmp/nginxt.txt 2>&1; then
  echo "NGINX_TEST_OK"
  cat /tmp/nginxt.txt
  if ${NGINX} -s reload > /tmp/nginxr.txt 2>&1; then echo "NGINX_RELOADED_OK"; else echo "NGINX_RELOAD_FAILED"; cat /tmp/nginxr.txt; fi
else
  echo "NGINX_TEST_FAILED_RESTORING_BACKUP"
  cat /tmp/nginxt.txt
  cp "${BAK}" "${VHOST}"
  echo "RESTORED_FROM=${BAK}"
fi
'@
  $nginxScript = $nginxScript -replace "`r`n", "`n"
  Run $nginxScript 120

  Section 'BACKEND SMOKE TEST (e2e-smoke2.sh)'
  Run 'bash /opt/autotgc-src/deploy/e2e-smoke2.sh' 300

  Section 'PM2 STATUS'
  Run 'sudo -u autotgc bash -lc "pm2 list"' 60

  Section 'PM2 LOGS (err + out, last 20)'
  Run 'echo "=== err logs ===" ; for f in /var/log/autotgc/err*.log; do echo "-- $f --"; tail -n 20 "$f" 2>/dev/null; done ; echo "=== out logs ===" ; for f in /var/log/autotgc/out*.log; do echo "-- $f --"; tail -n 20 "$f" 2>/dev/null; done'

  Section 'POST-DEPLOY VERIFY (backend direct :3000)'
  Run 'echo "HEALTHZ=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/healthz)" ; echo "READYZ_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/readyz)" ; echo "READYZ_BODY=$(curl -s http://127.0.0.1:3000/readyz)" ; echo "API_V1=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/v1)"'

  Section 'POST-DEPLOY VERIFY (through nginx :8088)'
  Run 'echo "SPA_ROOT=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/)" ; echo "SPA_DEEPLINK_LEADS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/leads)" ; echo "NGINX_HEALTHZ=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/healthz)" ; echo "NGINX_API_V1=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/api/v1)" ; echo "--- index.html marker check ---" ; curl -s http://127.0.0.1:8088/ | grep -o "<div id=\"root\"></div>\|/assets/index-[A-Za-z0-9_-]*\.js" | head'

  Section 'DB TABLE CHECK (WorkflowRun / WorkflowStep on PG16 :5434)'
  $dbScript = @'
set -uo pipefail
printf 'SELECT 1 FROM "WorkflowRun" LIMIT 1;\n'  > /tmp/wf_run.sql
printf 'SELECT 1 FROM "WorkflowStep" LIMIT 1;\n' > /tmp/wf_step.sql
chown autotgc:autotgc /tmp/wf_run.sql /tmp/wf_step.sql
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/wf_run.sql && echo WORKFLOWRUN_OK' 2>&1
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db execute --schema prisma/schema.prisma --file /tmp/wf_step.sql && echo WORKFLOWSTEP_OK' 2>&1
rm -f /tmp/wf_run.sql /tmp/wf_step.sql
'@
  $dbScript = $dbScript -replace "`r`n", "`n"
  Run $dbScript 180

  Section 'OTHER SERVICES UNTOUCHED (ports + status)'
  Run 'echo "--- listening ports ---" ; ss -ltnp 2>/dev/null | grep -E ":5433|:5434|:6379|:3000|:8088" | sed -E "s/users:.*//" ; echo "--- pg14 :5433 ---" ; (curl -s -o /dev/null -w "%{http_code}\n" --max-time 3 http://127.0.0.1:5433 ; true) ; echo "PG14_PORT_OPEN=$(timeout 3 bash -c "</dev/tcp/127.0.0.1/5433" 2>/dev/null && echo yes || echo no)" ; echo "PG16_PORT_OPEN=$(timeout 3 bash -c "</dev/tcp/127.0.0.1/5434" 2>/dev/null && echo yes || echo no)" ; echo "REDIS_PORT_OPEN=$(timeout 3 bash -c "</dev/tcp/127.0.0.1/6379" 2>/dev/null && echo yes || echo no)" ; echo "REDIS_PING=$(redis-cli -p 6379 ping 2>/dev/null)" ; echo "--- panel nginx master still running ---" ; pgrep -f "/www/server/nginx/sbin/nginx" >/dev/null && echo PANEL_NGINX_RUNNING || echo PANEL_NGINX_NOT_RUNNING'
}
finally {
  Section 'CLOSE SESSIONS'
  if ($script:ssh)  { Remove-SSHSession  -SessionId $script:ssh.SessionId  | Out-Null }
  if ($script:sftp) { Remove-SFTPSession -SessionId $script:sftp.SessionId | Out-Null }
  Write-Host 'Sessions closed.'
}
