param(
  [ValidateSet('start', 'status', 'stop-db')]
  [string]$Action = 'start',
  [switch]$WebOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$goBin = Join-Path $projectRoot 'output/tools/go/bin'
$pgBin = Join-Path $projectRoot 'output/tools/pgsql/bin'
$pgData = Join-Path $projectRoot 'output/postgres'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$ffmpegDir = Get-ChildItem (Join-Path $projectRoot 'output/tools') -Directory -Filter 'ffmpeg*' | Select-Object -First 1
if ($ffmpegDir) {
  $env:FFMPEG_PATH = Join-Path $ffmpegDir.FullName 'bin/ffmpeg.exe'
  $env:FFPROBE_PATH = Join-Path $ffmpegDir.FullName 'bin/ffprobe.exe'
}
$env:Path = "$goBin;$pgBin;$env:Path"
if (!$env:GOPROXY) { $env:GOPROXY = 'https://goproxy.cn,direct' }

if (!(Test-Path -LiteralPath $pgCtl) -or !(Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
  throw 'Local PostgreSQL is not initialized. See docs/10-local-development.md.'
}

if ($Action -eq 'stop-db') {
  & $pgCtl -D $pgData -m fast -w stop
  exit $LASTEXITCODE
}

& $pgCtl -D $pgData status
$databaseRunning = $LASTEXITCODE -eq 0
if ($Action -eq 'status') {
  foreach ($port in @(5173, 5174, 18080, 18081, 55432)) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    Write-Host ("Port {0}: {1}" -f $port, $(if ($listener) { 'listening' } else { 'stopped' }))
  }
  exit 0
}

if (!(Test-Path -LiteralPath '.env.local')) { throw '.env.local is missing.' }
if (!$databaseRunning) {
  $pgLog = Join-Path $projectRoot 'output/logs/postgres.log'
  $pgArguments = @('-D', ('"{0}"' -f $pgData), '-l', ('"{0}"' -f $pgLog), '-o', '"-h 127.0.0.1 -p 55432"', '-w', 'start')
  $pgProcess = Start-Process -FilePath $pgCtl -ArgumentList $pgArguments -WindowStyle Hidden -PassThru
  $pgProcess.WaitForExit()
  if ($pgProcess.ExitCode -ne 0) { throw "PostgreSQL failed to start. Check $pgLog" }
}

$busyPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(5173, 5174, 18080, 18081) }
if ($busyPorts) { throw 'Application ports are already in use. Run -Action status and use the existing services, or stop them before starting again.' }

Write-Host 'Client: http://127.0.0.1:5173 | Admin: http://127.0.0.1:5174/#/admin/dashboard'
Write-Host 'Ctrl+C stops application services; PostgreSQL remains available. Use -Action stop-db to stop the database.'
$clientCommand = if ($WebOnly) { 'corepack pnpm dev:web' } else { 'corepack pnpm dev:desktop' }
& corepack pnpm exec concurrently -k -n control,cloud,admin,client 'node scripts/service.mjs control' 'node scripts/service.mjs cloud' 'corepack pnpm dev:admin' $clientCommand
exit $LASTEXITCODE
