# Enable opt-in autopilot cron flags in /opt/autotgc/.env (append-or-replace),
# fix perms, restart PM2 with --update-env, and confirm by COUNT + names only
# (never prints any .env values). Password comes ONLY from $env:DEPLOY_PASSWORD.
param([string]$ServerHost = '36.50.26.118')

$ErrorActionPreference = 'Continue'
Import-Module Posh-SSH -ErrorAction Stop
if (-not $env:DEPLOY_PASSWORD) { throw 'DEPLOY_PASSWORD env var is not set' }
$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)

function Section([string]$t) { Write-Host "`n========== $t ==========" }
function Run([string]$cmd, [int]$timeout = 120) {
  $r = Invoke-SSHCommand -SessionId $script:ssh.SessionId -Command $cmd -TimeOut $timeout
  if ($r.Output) { $r.Output | ForEach-Object { Write-Host $_ } }
  if ($r.Error)  { $r.Error  | ForEach-Object { Write-Host "ERR: $_" } }
  return $r
}

Section 'OPEN SESSION'
$script:ssh = New-SSHSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
Write-Host "SSH session: $($script:ssh.SessionId) connected=$($script:ssh.Connected)"

try {
  Section 'APPEND-OR-REPLACE AUTOPILOT ENV FLAGS'
  $envScript = @'
set -uo pipefail
F=/opt/autotgc/.env
set_key() {
  local k="$1"; local v="$2"
  if grep -q "^${k}=" "$F"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$F"
    echo "REPLACED ${k}"
  else
    echo "${k}=${v}" >> "$F"
    echo "APPENDED ${k}"
  fi
}
set_key AUTOPILOT_ASSET_RETRY true
set_key AUTOPILOT_AUTO_RESEARCH true
set_key AUTOPILOT_AUTO_PLAN true
set_key AUTOPILOT_MARKETS JAPAN,KOREA,GERMANY,TAIWAN
chmod 600 "$F"
chown autotgc:autotgc "$F"
echo "PERMS=$(stat -c '%a %U:%G' "$F")"
echo "AUTOPILOT_KEY_COUNT=$(grep -cE '^(AUTOPILOT_ASSET_RETRY|AUTOPILOT_AUTO_RESEARCH|AUTOPILOT_AUTO_PLAN|AUTOPILOT_MARKETS)=' "$F")"
echo "--- key names present (values hidden) ---"
grep -oE '^(AUTOPILOT_ASSET_RETRY|AUTOPILOT_AUTO_RESEARCH|AUTOPILOT_AUTO_PLAN|AUTOPILOT_MARKETS)=' "$F" | sed 's/=$//' | sort
'@
  $envScript = $envScript -replace "`r`n", "`n"
  Run $envScript 120

  Section 'PM2 RESTART --update-env + save'
  Run 'sudo -u autotgc bash -lc "cd /opt/autotgc && pm2 restart autotgc-backend --update-env && pm2 save"' 120
  Start-Sleep -Seconds 8

  Section 'PM2 STATUS'
  Run 'sudo -u autotgc bash -lc "pm2 list"' 60

  Section 'STARTUP LOG: Scheduled jobs started (optionalJobs)'
  Run 'grep -F "Scheduled jobs started" /var/log/autotgc/out-0.log | tail -1' 60
}
finally {
  Section 'CLOSE SESSION'
  if ($script:ssh) { Remove-SSHSession -SessionId $script:ssh.SessionId | Out-Null }
  Write-Host 'Session closed.'
}
