# Frontend-only redeploy: uploads the built SPA dist and swaps it in atomically.
# Password comes ONLY from $env:DEPLOY_PASSWORD (never written to disk).
param(
  [string]$ServerHost = '36.50.26.118',
  [string]$FeTar = 'C:\Users\PC\Documents\docs\autotgc-frontend-dist.tar.gz'
)

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

Section 'OPEN SESSIONS'
$script:ssh  = New-SSHSession  -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
$script:sftp = New-SFTPSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
Write-Host "SSH session:  $($script:ssh.SessionId)  connected=$($script:ssh.Connected)"

try {
  Section 'UPLOAD FRONTEND TARBALL'
  Set-SFTPItem -SessionId $script:sftp.SessionId -Path $FeTar -Destination '/tmp' -Force
  Run 'ls -la /tmp/autotgc-frontend-dist.tar.gz'

  Section 'DEPLOY FRONTEND DIST (extract to staging, atomic swap)'
  $swap = @'
set -uo pipefail
rm -rf /tmp/fe-stage ; mkdir -p /tmp/fe-stage
tar -xzf /tmp/autotgc-frontend-dist.tar.gz -C /tmp/fe-stage
echo "--- staged dist ---"
ls -la /tmp/fe-stage/dist | head
mkdir -p /opt/autotgc-frontend
rm -rf /opt/autotgc-frontend/dist.old
[ -d /opt/autotgc-frontend/dist ] && mv /opt/autotgc-frontend/dist /opt/autotgc-frontend/dist.old
mv /tmp/fe-stage/dist /opt/autotgc-frontend/dist
chown -R autotgc:autotgc /opt/autotgc-frontend
rm -rf /opt/autotgc-frontend/dist.old
echo "--- live dist ---"
ls -la /opt/autotgc-frontend/dist
echo "--- assets ---"
ls -la /opt/autotgc-frontend/dist/assets
'@
  $swap = $swap -replace "`r`n", "`n"
  Run $swap 120

  Section 'VERIFY THROUGH NGINX :8088'
  Run 'echo "SPA_ROOT=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/)" ; echo "SPA_DEEPLINK_ANALYTICS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/analytics)" ; echo "--- index asset marker ---" ; curl -s http://127.0.0.1:8088/ | grep -o "/assets/index-[A-Za-z0-9_-]*\.\(js\|css\)" | head'
}
finally {
  Section 'CLOSE SESSIONS'
  if ($script:ssh)  { Remove-SSHSession  -SessionId $script:ssh.SessionId  | Out-Null }
  if ($script:sftp) { Remove-SFTPSession -SessionId $script:sftp.SessionId | Out-Null }
  Write-Host 'Sessions closed.'
}
