param(
  [string]$ToolsRoot = '',
  [switch]$WebOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath '.env.local')) { throw '.env.local is missing.' }
if (!$ToolsRoot) { $ToolsRoot = Join-Path $projectRoot 'output/tools' }
$goBin = Join-Path $ToolsRoot 'go/bin'
if (!(Test-Path -LiteralPath (Join-Path $goBin 'go.exe'))) {
  throw 'Go is missing. Pass -ToolsRoot pointing to the existing output/tools directory.'
}
$env:Path = "$goBin;$env:Path"
if (!$env:GOPROXY) { $env:GOPROXY = 'https://goproxy.cn,direct' }

$busyPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(5173, 5174, 18080, 18081) }
if ($busyPorts) { throw 'Application ports are occupied. Stop the other workspace application before starting this worktree.' }
if (!(Get-NetTCPConnection -State Listen -LocalPort 5432 -ErrorAction SilentlyContinue)) {
  throw 'Start the local PostgreSQL instance on port 5432 first. This script does not manage shared database processes.'
}

Write-Host 'Starting the production worktree with its own Electron profile. Ctrl+C stops application services.'
& corepack pnpm build:publishing
if ($LASTEXITCODE -ne 0) { throw 'Desktop publishing runtime build failed.' }
$profileDirectory = Join-Path $projectRoot 'output/electron-user-data'
$desktopCommand = 'corepack pnpm exec wait-on http://127.0.0.1:5173 http://127.0.0.1:18080/api/auth/jwks && corepack pnpm exec electron apps/desktop/electron/main.cjs --user-data-dir="{0}"' -f $profileDirectory
$commands = @('node scripts/service.mjs control', 'node scripts/service.mjs cloud', 'corepack pnpm dev:admin', 'corepack pnpm dev:web')
if (!$WebOnly) { $commands += $desktopCommand }
& corepack pnpm exec concurrently -k @commands
exit $LASTEXITCODE
