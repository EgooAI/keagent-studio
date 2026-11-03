param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($inputData.list) {
    $voices = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { @{ name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name } })
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
    ConvertTo-Json -InputObject $voices -Compress
  } else {
    $speaker.SelectVoice([string]$inputData.voice)
    $speaker.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$inputData.rate))
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $speaker.SetOutputToWaveFile([string]$inputData.output, $format)
    $speaker.Speak([string]$inputData.text)
    $speaker.SetOutputToNull()
  }
} finally { $speaker.Dispose() }
