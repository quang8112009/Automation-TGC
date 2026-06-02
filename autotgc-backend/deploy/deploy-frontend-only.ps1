# Frontend-only deploy: upload + extract the SPA dist, fix ownership, verify.
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

$ssh = New-SSHSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
$sftp = New-SFTPSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
try {
  Write-Host '== UPLOAD =='
  Set-SFTPItem -SessionId $sftp.SessionId -Path $FeTar -Destination '/tmp' -Force
  $deploy = @'
set -uo pipefail
mkdir -p /opt/autotgc-frontend
rm -rf /opt/autotgc-frontend/dist
tar -xzf /tmp/autotgc-frontend-dist.tar.gz -C /opt/autotgc-frontend
chown -R autotgc:autotgc /opt/autotgc-frontend
echo "DIST:"; ls /opt/autotgc-frontend/dist | head
echo "SPA_ROOT=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8088/)"
echo "SPA_INTAKE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8088/intake)"
echo "SPA_PARTNERS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8088/partners)"
echo "JS_BUNDLE=$(curl -s http://127.0.0.1:8088/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)"
'@
  $deploy = $deploy -replace "`r`n", "`n"
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $deploy -TimeOut 120
  $r.Output | ForEach-Object { Write-Host $_ }
  if ($r.Error) { $r.Error | ForEach-Object { Write-Host "ERR: $_" } }
}
finally {
  Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
  Remove-SFTPSession -SessionId $sftp.SessionId | Out-Null
}
