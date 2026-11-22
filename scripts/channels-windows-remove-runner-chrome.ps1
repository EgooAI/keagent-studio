# Only the disposable GitHub runner removes Chrome. The clean-machine check never uninstalls it.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:ImageOS -ne 'win25' -or -not $env:ImageVersion -or -not $env:RUNNER_TEMP -or
    (Get-CimInstance Win32_ComputerSystem).Model -notmatch 'Virtual Machine') {
    throw 'Chrome removal is restricted to a GitHub-hosted windows-2025 virtual machine.'
}

$keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$products = @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Google Chrome' -and $_.Publisher -match '^Google (LLC|Inc\.?)$' })
foreach ($product in $products) {
    if ($product.PSChildName -match '^\{[a-fA-F0-9-]{36}\}$' -and
        ($product.WindowsInstaller -eq 1 -or $product.UninstallString -match 'msiexec')) {
        $uninstaller = Join-Path $env:SystemRoot 'System32\msiexec.exe'
        $arguments = @('/x', $product.PSChildName, '/qn', '/norestart')
    } else {
        if ($product.UninstallString -notmatch '^"([^"]+\\Installer\\setup\.exe)"') {
            throw 'Unrecognized Google Chrome uninstaller.'
        }
        $uninstaller = (Resolve-Path -LiteralPath $Matches[1]).Path
        $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) |
            Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Google\Chrome\Application\' }
        if (-not @($roots | Where-Object { $uninstaller.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count) {
            throw 'Unexpected Google Chrome installer location.'
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $uninstaller
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Google (LLC|Inc)') {
            throw 'Uninstaller signature does not identify Google.'
        }
        $arguments = @('--uninstall', '--channel=stable', '--force-uninstall')
        if ($product.UninstallString -match '--system-level' -or $product.PSPath -match 'HKEY_LOCAL_MACHINE') {
            $arguments += '--system-level'
        }
    }
    $proc = Start-Process -FilePath $uninstaller -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($proc.ExitCode -notin 0,1605,3010) { throw "Google Chrome uninstall failed ($($proc.ExitCode))." }
}
Write-Host "Processed $($products.Count) installed Google Chrome entries on the disposable runner."
