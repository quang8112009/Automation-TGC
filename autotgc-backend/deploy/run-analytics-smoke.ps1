# Upload analytics-smoke.sh and run it on the server. Password from $env:DEPLOY_PASSWORD only.
param([string]$ServerHost = '36.50.26.118',
      [string]$Script = 'C:\Users\PC\Documents\docs\autotgc-backend\deploy\analytics-smoke.sh')

$ErrorActionPreference = 'Continue'
Import-Module Posh-SSH -ErrorAction Stop
if (-not $env:DEPLOY_PASSWORD) { throw 'DEPLOY_PASSWORD env var is not set' }
$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)

$ssh  = New-SSHSession  -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
$sftp = New-SFTPSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
try {
  Set-SFTPItem -SessionId $sftp.SessionId -Path $Script -Destination '/tmp' -Force
  # Normalize CRLF -> LF then run
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command "sed -i 's/\r$//' /tmp/analytics-smoke.sh; bash /tmp/analytics-smoke.sh" -TimeOut 180
  if ($r.Output) { $r.Output | ForEach-Object { Write-Host $_ } }
  if ($r.Error)  { $r.Error  | ForEach-Object { Write-Host "ERR: $_" } }
}
finally {
  if ($ssh)  { Remove-SSHSession  -SessionId $ssh.SessionId  | Out-Null }
  if ($sftp) { Remove-SFTPSession -SessionId $sftp.SessionId | Out-Null }
  Write-Host 'Sessions closed.'
}
