param(
    [string]$Installer,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'A Windows guest is required.' }

function Assert-NoSystemChrome {
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($root in $roots) {
        foreach ($edition in 'Chrome','Chrome Beta','Chrome Dev','Chrome SxS') {
            if (Test-Path -LiteralPath (Join-Path $root "Google\$edition\Application\chrome.exe")) {
                throw 'System Google Chrome is installed. This guest does not qualify.'
            }
        }
    }
    foreach ($hive in 'HKLM:','HKCU:') {
        foreach ($software in 'SOFTWARE','SOFTWARE\WOW6432Node') {
            $registry = "$hive\$software\Microsoft\Windows\CurrentVersion"
            if (Test-Path -LiteralPath "$registry\App Paths\chrome.exe") { throw 'Google Chrome App Paths entry found.' }
            $installed = Get-ItemProperty "$registry\Uninstall\*" -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match '^Google Chrome($| )' }
            if ($installed) { throw 'Google Chrome uninstall entry found.' }
        }
    }
    if (Get-Command chrome.exe -ErrorAction SilentlyContinue) { throw 'chrome.exe found on PATH.' }
}

function Write-Result([string]$Message) {
    Write-Host $Message
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "- $Message" }
}

Assert-NoSystemChrome
Write-Result 'Guest passed system Chrome absence checks (program directories, App Paths, uninstall records, PATH).'
if ($CheckOnly) { return }
if (-not $Installer) { throw 'Pass -Installer with the path to the packaged Windows NSIS installer.' }
$package = (Get-Item -LiteralPath $Installer).FullName
$repo = Split-Path $PSScriptRoot
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('laike-clean-' + [Guid]::NewGuid().ToString('N'))
$installation = Join-Path $scratch 'app'
$null = New-Item -ItemType Directory -Path $scratch
$setup = Start-Process -FilePath $package -ArgumentList @('/S', "/D=$installation") -WindowStyle Hidden -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "NSIS failed ($($setup.ExitCode))." }
$executables = @(Get-ChildItem -LiteralPath $installation -File -Filter 'AI*.exe')
if ($executables.Count -ne 1) { throw 'Could not identify the installed AI-Laike executable.' }
$worker = (Get-Item -LiteralPath (Join-Path $installation 'resources/channels-runtime/channels-worker.exe')).FullName
$binary = (Get-Item -LiteralPath (Join-Path $installation 'resources/channels-browser/chrome.exe')).FullName

& node (Join-Path $PSScriptRoot 'douyin-package-smoke.mjs') $executables[0].FullName
if ($LASTEXITCODE -ne 0) { throw 'Packaged Electron smoke failed.' }
Assert-NoSystemChrome
$result = & $worker --chrome-self-test
if ($LASTEXITCODE -ne 0) { throw 'Worker default launch failed.' }
$selection = $result | ConvertFrom-Json
if ($selection.event -ne 'ready' -or $selection.browser -ne 'bundled' -or $selection.h264 -ne $true) {
    throw 'Normal first-use selection did not report the bundled browser decoding H.264.'
}
Write-Result "NSIS installation, Electron login screen, default browser selection and H.264 decode passed (browser $($selection.version))."

# This fixture intercepts all web requests. It does not use credentials or publish externally.
$python = Join-Path $repo 'output/channels-build/chrome-venv/Scripts/python.exe'
& $python (Join-Path $PSScriptRoot 'channels-chrome-integration.py') --account-login-fixture
if ($LASTEXITCODE -ne 0) { throw 'Loopback login and cold-start fixture failed.' }
Write-Result 'Loopback login iframe approval and headless reuse passed using the normal browser selection path.'
& $python (Join-Path $PSScriptRoot 'channels-chrome-integration.py')
if ($LASTEXITCODE -ne 0) { throw 'Offline upload and account isolation fixture failed.' }
Write-Result 'Loopback fixtures passed for upload, verification, submit, account isolation and reuse. No external post was made.'

# The live probe only returns two booleans and the logged-out status. No QR values leave the page.
$probe = @'
() => {
  const official = location.origin === "https://channels.weixin.qq.com";
  const qr = official && Array.from(document.querySelectorAll("iframe")).some(frame => {
    const url = new URL(frame.src, location.href);
    const bounds = frame.getBoundingClientRect();
    return url.origin === "https://open.weixin.qq.com" && url.pathname === "/connect/qrconnect" &&
      bounds.width > 1 && bounds.height > 1;
  });
  return {status: official && (qr || location.pathname === "/login.html") ? "logged_out" : "unknown", officialQrFrame: qr};
}
'@
$profile = Join-Path $scratch 'test-account/chrome-profile'
function Test-AccountJob([string]$Action) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $worker
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $proc = [Diagnostics.Process]::Start($info)
    $seenBrowser = $false
    $seenWindow = $false
    $opened = $false
    $qr = $false
    try {
        $proc.StandardInput.WriteLine((@{ action=$Action; profileDir=$profile; accountProbe=$probe } | ConvertTo-Json -Compress))
        $proc.StandardInput.Flush()
        $line = $proc.StandardOutput.ReadLineAsync()
        $deadline = [DateTime]::UtcNow.AddSeconds(80)
        while ([DateTime]::UtcNow -lt $deadline) {
            foreach ($chrome in @(Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
                if ($chrome.Path -eq $binary) {
                    $seenBrowser = $true
                    if ($chrome.MainWindowHandle -ne 0) { $seenWindow = $true }
                }
            }
            if ($line.IsCompleted) {
                $json = $line.GetAwaiter().GetResult()
                if ($null -eq $json) { break }
                $event = $json | ConvertFrom-Json
                if ($event.event -eq 'opened') { $opened = $true }
                if ($event.event -eq 'account') {
                    $qr = $event.status -eq 'logged_out' -and $event.officialQrFrame -eq $true
                    break
                }
                if ($event.event -eq 'error') { break }
                $line = $proc.StandardOutput.ReadLineAsync()
            }
            if ($Action -eq 'login' -and $opened -and $seenWindow) { break }
            Start-Sleep -Milliseconds 100
        }
    } finally {
        $proc.StandardInput.Close()
        if (-not $proc.WaitForExit(20000)) { throw "Guest worker failed to close its $Action session." }
        $proc.Dispose()
    }
    return [pscustomobject]@{ Browser=$seenBrowser; Visible=$seenWindow; Opened=$opened; OfficialQr=$qr }
}

$login = Test-AccountJob 'login'
$check = Test-AccountJob 'check'
if (-not $login.Browser -or -not $login.Visible -or -not $check.Browser -or $check.Visible) {
    throw "Account window behavior failed: login browser=$($login.Browser) visible=$($login.Visible), check browser=$($check.Browser) visible=$($check.Visible)."
}
if (-not (Test-Path -LiteralPath (Join-Path $scratch 'test-account/chromium-profile/.ai-laike-browser-version'))) {
    throw 'Account jobs did not persist the expected independent bundled-browser profile.'
}
Write-Result 'Installed worker started a visible bundled login window and a windowless check using the same account profile.'
$decodedQr = $false
if ($login.Opened -and $check.OfficialQr) {
    $liveResult = & $worker --bundled-chrome-login-check
    if ($LASTEXITCODE -eq 0) {
        $live = $liveResult | ConvertFrom-Json
        $decodedQr = $live.event -eq 'ready' -and $live.qrImageLoaded -eq $true
    }
}
if (-not $decodedQr) {
    foreach ($origin in 'https://channels.weixin.qq.com/platform','https://open.weixin.qq.com/') {
        $status = & curl.exe --silent --output NUL --location --max-time 12 --write-out '%{http_code}' $origin
        Write-Result "Official HTTPS diagnostic for $(([uri]$origin).Host): HTTP $status, curl exit $LASTEXITCODE."
    }
    throw 'The official WeChat login, visible QR frame and decoded QR image were not all verified. See separate local results and HTTPS diagnostics.'
}
Write-Result 'Official WeChat login reached a visible QR iframe in the normal account check; the installed bundled browser also decoded the official QR image. Human scan and real posting were outside this runner test.'
