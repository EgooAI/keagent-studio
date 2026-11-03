$ErrorActionPreference = 'Stop'
$repoDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $repoDir 'apps\desktop\public\media\panoramas\manifest.json'
$demoDir = Join-Path $repoDir 'output\panorama-demo'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $demoDir -Force | Out-Null

Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
    if ($null -eq $voice) { throw 'A local zh-CN voice is required for this development demo.' }
    $speaker.SelectVoice($voice.VoiceInfo.Name)
    $speaker.Rate = 1
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    foreach ($asset in $manifest.assets) {
        if ($asset.id -notmatch '^[a-z0-9_]+$') { throw 'Invalid test asset ID.' }
        for ($index = 0; $index -lt $asset.narration.Count; $index++) {
            $audioPath = Join-Path $demoDir ($asset.id + '-' + $index + '.wav')
            $speaker.SetOutputToWaveFile($audioPath, $format)
            $speaker.Speak([string]$asset.narration[$index])
            $speaker.SetOutputToNull()
            if ((Get-Item -LiteralPath $audioPath).Length -le 44) { throw 'The synthesized audio is empty.' }
        }
    }
    [PSCustomObject]@{ Voice = $voice.VoiceInfo.Name; Scenes = $manifest.assets.Count; Output = $demoDir } | ConvertTo-Json -Compress
} finally { $speaker.Dispose() }
