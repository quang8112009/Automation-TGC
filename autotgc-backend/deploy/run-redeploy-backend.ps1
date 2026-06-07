# Backend-only redeploy for AutoTGC via Posh-SSH.
# Uploads the backend tarball, extracts to /opt/autotgc-src, runs redeploy2.sh
# (which preserves .env + media, installs deps, prisma db push, builds, restarts
# PM2), then verifies health. Does NOT touch the frontend dist or nginx config.
#
# Password comes ONLY from $env:DEPLOY_PASSWORD (never written to disk / never
# printed). Run from anywhere.
param(
  [Parameter(Mandatory = $true)]
  [string]$ServerHost,
  [string]$BeTar = 'C:\Users\PC\Documents\docs\autotgc.tar.gz'
)

$ErrorActionPreference = 'Continue'
Import-Module Posh-SSH -ErrorAction Stop

$script:deployFailed = $false

if (-not $env:DEPLOY_PASSWORD) { throw 'DEPLOY_PASSWORD env var is not set' }
if (-not (Test-Path $BeTar)) { throw "Backend tarball not found: $BeTar" }

$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)

function Section([string]$t) { Write-Host "`n========== $t ==========" }

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
  Section 'PRE-DEPLOY STATE (current health + git-ish marker)'
  Run 'echo "HEALTH_BEFORE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/healthz)" ; sudo -u autotgc bash -lc "pm2 list" 2>/dev/null | tail -5'

  Section 'UPLOAD BACKEND TARBALL'
  Set-SFTPItem -SessionId $script:sftp.SessionId -Path $BeTar -Destination '/tmp' -Force
  Run 'ls -la /tmp/autotgc.tar.gz'

  Section 'EXTRACT BACKEND SOURCE (/opt/autotgc-src)'
  Run 'rm -rf /opt/autotgc-src/* ; mkdir -p /opt/autotgc-src ; tar -xzf /tmp/autotgc.tar.gz -C /opt/autotgc-src --strip-components=1 ; echo "--- src top ---" ; ls /opt/autotgc-src ; echo "--- deploy dir ---" ; ls /opt/autotgc-src/deploy | head'

  Section 'RUN redeploy2.sh (nohup + poll up to 25 min)'
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

  Section 'POST-DEPLOY VERIFY (backend direct :3000)'
  $verify = Run 'echo "HEALTHZ=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/healthz)" ; echo "READYZ_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/readyz)" ; echo "READYZ_BODY=$(curl -s http://127.0.0.1:3000/readyz)" ; echo "API_V1=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/v1)"'

  # Health gate: parse the HEALTHZ/READYZ codes and FAIL the run on non-200 so an
  # unhealthy deploy never reports success (DONE alone is not a success signal).
  $verifyText = ($verify.Output -join "`n")
  $healthOk = $verifyText -match 'HEALTHZ=200'
  $readyOk  = $verifyText -match 'READYZ_CODE=200'
  if (-not ($healthOk -and $readyOk)) {
    Write-Host "!!! DEPLOY VERIFY FAILED: healthz/readyz did not both return 200 !!!"
    Write-Host "ROLLBACK: re-extract the previous good tarball to /opt/autotgc-src and re-run redeploy2.sh;"
    Write-Host "          if the schema changed, restore Postgres from the pre-push backup in /var/backups/autotgc/."
    $script:deployFailed = $true
  } else {
    Write-Host "DEPLOY VERIFY OK: healthz=200, readyz=200."
  }

  Section 'VERIFY TIMEOUT FIX PRESENT IN BUILD (dist/infra/gemini.js)'
  Run 'grep -o "GEMINI_DEFAULT_TIMEOUT_MS\|timeoutMs" /opt/autotgc/dist/infra/gemini.js | sort -u ; echo "---" ; grep -o "AbortController\|timeoutMs" /opt/autotgc/dist/platforms/httpClient.js | sort -u'

  Section 'PM2 STATUS + RECENT LOGS'
  Run 'sudo -u autotgc bash -lc "pm2 list" 2>/dev/null | tail -6 ; echo "=== err (last 12) ===" ; for f in /var/log/autotgc/err*.log; do tail -n 12 "$f" 2>/dev/null; done'
}
finally {
  Section 'CLOSE SESSIONS'
  if ($script:ssh)  { Remove-SSHSession  -SessionId $script:ssh.SessionId  | Out-Null }
  if ($script:sftp) { Remove-SFTPSession -SessionId $script:sftp.SessionId | Out-Null }
  Write-Host 'Sessions closed.'
}

# Non-zero exit on a failed health gate so CI / callers detect an unhealthy deploy.
if ($script:deployFailed) {
  Write-Host 'REDEPLOY RESULT: FAILED (see verify section above).'
  exit 1
}
Write-Host 'REDEPLOY RESULT: OK.'
