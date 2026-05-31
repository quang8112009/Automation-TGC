param(
  [string]$BaseUrl  = 'http://36.50.26.118:8088',
  [string]$Username = 'admin',
  [string]$Password = 'Admin@12345'
)
$ErrorActionPreference = 'Stop'
$body = @{ username = $Username; password = $Password } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/auth/login" -ContentType 'application/json' -Body $body -TimeoutSec 30
  Write-Host ('LOGIN_OK role=' + $r.user.role + ' user=' + $r.user.username)
}
catch {
  Write-Host ('LOGIN_FAILED: ' + $_.Exception.Message)
}
