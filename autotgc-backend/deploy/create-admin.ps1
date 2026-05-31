# One-off: register an ADMIN test account on the live server, via the public API.
# Credentials are passed as params (not hardcoded secrets in the repo sense; this
# is an intentionally-shared test login). Prints the server's JSON response.
param(
  [string]$BaseUrl  = 'http://36.50.26.118:8088',
  [string]$Username = 'admin',
  [string]$Email    = 'admin@autotgc.local',
  [string]$Password = 'Admin@12345'
)
$ErrorActionPreference = 'Stop'

$body = @{
  username             = $Username
  email                = $Email
  password             = $Password
  passwordConfirmation = $Password
} | ConvertTo-Json

Write-Host "POST $BaseUrl/api/auth/register (username=$Username)"
try {
  $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/auth/register" `
    -ContentType 'application/json' -Body $body -TimeoutSec 30
  Write-Host 'REGISTER_OK'
  Write-Host ("role={0} userId={1}" -f $resp.user.role, $resp.user.id)
  Write-Host ("accessToken_prefix={0}..." -f $resp.tokens.accessToken.Substring(0, 24))
}
catch {
  $r = $_.Exception.Response
  if ($r) {
    $reader = New-Object System.IO.StreamReader($r.GetResponseStream())
    $errBody = $reader.ReadToEnd()
    Write-Host "REGISTER_FAILED status=$([int]$r.StatusCode)"
    Write-Host $errBody
  } else {
    Write-Host "REGISTER_ERROR: $($_.Exception.Message)"
  }
}
