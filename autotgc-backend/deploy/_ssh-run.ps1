# Helper: run a remote bash command/script on the server over SSH (Posh-SSH).
# Password is passed as a parameter (never written to disk).
#
# Usage (inline):  _ssh-run.ps1 -ServerHost 1.2.3.4 -Password '...' -Command 'uname -a'
# Usage (file):    _ssh-run.ps1 -ServerHost 1.2.3.4 -Password '...' -ScriptFile .\local.sh
#                  (the local script is uploaded to /tmp and executed with bash)
param(
  [Parameter(Mandatory = $true)][string]$ServerHost,
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$Command,
  [string]$ScriptFile,
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH -ErrorAction Stop
$pw = ConvertTo-SecureString $Password -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('root', $pw)
$ssh = New-SSHSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
$sftp = $null
try {
  if ($ScriptFile) {
    $sftp = New-SFTPSession -ComputerName $ServerHost -Credential $cred -AcceptKey -ConnectionTimeout 60
    $remote = '/tmp/_kiro_run.sh'
    Set-SFTPItem -SessionId $sftp.SessionId -Path $ScriptFile -Destination '/tmp' -Force
    $base = Split-Path -Leaf $ScriptFile
    $cmd = "sed -i 's/\r`$//' /tmp/$base && bash /tmp/$base"
  }
  else {
    $cmd = $Command -replace "`r`n", "`n"
  }
  $r = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $cmd -TimeOut $TimeoutSec
  if ($r.Output) { $r.Output | ForEach-Object { Write-Host $_ } }
  if ($r.Error)  { $r.Error  | ForEach-Object { Write-Host "ERR: $_" } }
  Write-Host "EXIT=$($r.ExitStatus)"
}
finally {
  if ($sftp) { Remove-SFTPSession -SessionId $sftp.SessionId | Out-Null }
  Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
}
