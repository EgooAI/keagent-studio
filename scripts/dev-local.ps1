param(
  [ValidateSet('start', 'status', 'stop-db')]
  [string]$Action = 'start',
  [switch]$WebOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$goBin = Join-Path $projectRoot 'output/tools/go/bin'
$ffmpegDir = Get-ChildItem (Join-Path $projectRoot 'output/tools') -Directory -Filter 'ffmpeg*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ffmpegDir) {
  $env:FFMPEG_PATH = Join-Path $ffmpegDir.FullName 'bin/ffmpeg.exe'
  $env:FFPROBE_PATH = Join-Path $ffmpegDir.FullName 'bin/ffprobe.exe'
}
$env:Path = "$goBin;$env:Path"
if (!$env:GOPROXY) { $env:GOPROXY = 'https://goproxy.cn,direct' }

if ($Action -eq 'stop-db') {
  throw 'PostgreSQL on port 5432 is shared. This script does not stop it.'
}

if ($Action -eq 'status') {
  foreach ($port in @(5173, 5174, 18080, 18081, 5432)) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    Write-Host ("Port {0}: {1}" -f $port, $(if ($listener) { 'listening' } else { 'stopped' }))
  }
  exit 0
}

if (!(Test-Path -LiteralPath '.env.local')) { throw '.env.local is missing.' }
if (!(Get-NetTCPConnection -State Listen -LocalPort 5432 -ErrorAction SilentlyContinue)) {
  throw 'Start the local PostgreSQL service on port 5432 first.'
}

$busyPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(5173, 5174, 18080, 18081) }
if ($busyPorts) { throw 'Application ports are already in use. Run -Action status and use the existing services, or stop them before starting again.' }

Write-Host 'Client: http://127.0.0.1:5173 | Admin: http://127.0.0.1:5174/#/admin/dashboard'
Write-Host 'Ctrl+C stops application services; the shared PostgreSQL service remains running.'
$clientCommand = if ($WebOnly) { 'corepack pnpm dev:web' } else { 'corepack pnpm dev:desktop' }
& corepack pnpm exec concurrently -k -n control,cloud,admin,client 'node scripts/service.mjs control' 'node scripts/service.mjs cloud' 'corepack pnpm dev:admin' $clientCommand
exit $LASTEXITCODE
