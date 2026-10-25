# Keeps a public https link to the Vouch server on this laptop alive, and tells you the new address whenever it has to change.
#   powershell -ExecutionPolicy Bypass -File web\dev\keep-link-alive.ps1
# Free "quick tunnels" can die when the laptop sleeps or the network changes. This checks the link every 20 seconds; if it stops
# answering it starts a fresh tunnel, saves the new address to .env (VOUCH_URL, so the Telegram menu button and alerts point at it),
# restarts the server, and writes the address to link.txt next to this script's log. Phones remember Vouch PER ADDRESS, so a changed
# address means signing up again on each phone: the only real fix for that is a deployed address (Render + a custom domain).
param([int]$Port = 3000, [string]$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe')
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$run = Join-Path $env:TEMP 'vouch-run'; New-Item -ItemType Directory -Force $run | Out-Null
$linkFile = Join-Path $run 'link.txt'

# Stop the laptop going to sleep while plugged in (a sleeping laptop is what kills the tunnel).
try { powercfg /change standby-timeout-ac 0 | Out-Null; powercfg /change standby-timeout-dc 0 | Out-Null; powercfg /change monitor-timeout-ac 30 | Out-Null } catch { }

function Start-Server {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'serve.js' -and $_.CommandLine -match '\.env' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep 1
  Start-Process node -ArgumentList '--env-file=.env', 'bot/serve.js' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $run 'real.log') -RedirectStandardError (Join-Path $run 'real.err')
}
function Start-Tunnel {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item (Join-Path $run 'tunnel.err'), (Join-Path $run 'tunnel.out') -ErrorAction SilentlyContinue
  Start-Process $Cloudflared -ArgumentList 'tunnel', '--url', "http://localhost:$Port", '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4' -WindowStyle Hidden -RedirectStandardOutput (Join-Path $run 'tunnel.out') -RedirectStandardError (Join-Path $run 'tunnel.err')
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep 1
    $m = Select-String -Path (Join-Path $run 'tunnel.err') -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { return $m.Matches[0].Value }
  }
  return $null
}
function Test-Link($url) { try { return ((Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 15).Content -match 'ok') } catch { return $false } }

$url = $null
if (Test-Path $linkFile) { $url = (Get-Content $linkFile -Raw).Trim() }
while ($true) {
  if (-not $url -or -not (Test-Link $url) -or -not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "$(Get-Date -Format HH:mm:ss) link is down, starting a new one..."
    $url = Start-Tunnel
    if ($url) {
      Start-Sleep 6
      $envFile = Join-Path $repo '.env'
      $lines = @(); if (Test-Path $envFile) { $lines = Get-Content $envFile | Where-Object { $_ -notmatch '^VOUCH_URL=' } }
      ($lines + "VOUCH_URL=$url") | Set-Content $envFile -Encoding ascii
      Start-Server
      $url | Set-Content $linkFile -Encoding ascii
      Write-Host "$(Get-Date -Format HH:mm:ss) NEW LINK: $url   (phones must sign up again on a new address)"
    } else { Write-Host "$(Get-Date -Format HH:mm:ss) could not get a tunnel, will retry" }
  }
  # The server itself must be up too (the tunnel can be fine while the server has died).
  if (-not (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'serve.js' -and $_.CommandLine -match '\.env' })) {
    Write-Host "$(Get-Date -Format HH:mm:ss) the server was not running, starting it"
    Start-Server
  }
  Start-Sleep 10
}
