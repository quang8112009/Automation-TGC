# Deploy AutoTGC backend to the server over SSH/SCP using Posh-SSH.
# Password is passed via environment (DEPLOY_PASSWORD) and never written to disk.
param(
  [Parameter(Mandatory = $true)][string]$ServerHost,
  [Parameter(Mandatory = $true)][string]$TarPath
)
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH

$pw = ConvertTo-SecureString $env:DEPLOY_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)

Write-Host '== Opening SSH/SFTP sessions =='
$ssh = New-SSHSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
$sftp = New-SFTPSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60

function Run([string]$cmd, [int]$timeout = 900) {
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut $timeout
  if ($r.Output) { $r.Output | ForEach-Object { Write-Host $_ } }
  if ($r.Error)  { $r.Error  | ForEach-Object { Write-Host "ERR: $_" } }
  if ($r.ExitStatus -ne 0) { throw "Command failed (exit $($r.ExitStatus)): $cmd" }
  return $r
}

Write-Host '== Uploading package =='
Run 'mkdir -p /opt/autotgc-src'
Set-SFTPItem -SessionId $sftp.SessionId -Path $TarPath -Destination '/tmp' -Force
Run 'rm -rf /opt/autotgc-src/* && tar -xzf /tmp/autotgc.tar.gz -C /opt/autotgc-src && ls /opt/autotgc-src'

Write-Host '== Provisioning (Node/PG16/Redis/Nginx/PM2/user) =='
Run 'bash /opt/autotgc-src/deploy/provision.sh' 1800

Write-Host '== Done deploy stage 1 =='
Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
Remove-SFTPSession -SessionId $sftp.SessionId | Out-Null
