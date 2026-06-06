# Verify the deployed SPA on production actually contains the new study-abroad
# chunks (InterviewPrep, CandidateDetail) and that index.html references the
# current asset bundle. Password from $env:DEPLOY_PASSWORD only.
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
  Write-Host '========== DEPLOYED DIST: new chunks present? =========='
  Run 'ls -1 /opt/autotgc-frontend/dist/assets/ | grep -iE "InterviewPrep|CandidateDetail" || echo "NO_NEW_CHUNKS_FOUND"'

  Write-Host '========== DIST BUILD TIME (mtime of index.html) =========='
  Run 'stat -c "%y  %n" /opt/autotgc-frontend/dist/index.html'

  Write-Host '========== index.html main bundle reference =========='
  Run 'grep -o "/assets/index-[A-Za-z0-9_-]*\.js" /opt/autotgc-frontend/dist/index.html | head'

  Write-Host '========== served through nginx :8088 (interview-prep chunk fetch) =========='
  Run 'CHUNK=$(ls -1 /opt/autotgc-frontend/dist/assets/ | grep -i InterviewPrep | head -1) ; echo "CHUNK=$CHUNK" ; echo "HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/assets/$CHUNK)"'
}
finally {
  if ($ssh) { Remove-SSHSession -SessionId $ssh.SessionId | Out-Null }
  Write-Host 'Session closed.'
}
