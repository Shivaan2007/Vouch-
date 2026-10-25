# Makes the call test clips from the staged scripts in docs/LIVE-CALL-DEMO.md, with the voices built into Windows (no account, no key).
# Run:  powershell -ExecutionPolicy Bypass -File web\dev\make-clips.ps1
# The clips land in web\dev\audio\ (kept out of git on purpose: never commit audio). Open http://localhost:3000/dev/call-lab.html to play them.
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot 'audio'; New-Item -ItemType Directory -Force $out | Out-Null
$clips = [ordered]@{
  'bank-call' = @('Zira', @(
    'Hello, this is the fraud department at First Harbor Bank. Am I speaking with Mr. Lee?',
    'We noticed a payment of four hundred and eighty dollars that you may not recognise. I would like to help you cancel it.',
    'To cancel it I just need the six digit code we texted you. Please read it to me.',
    'Please stay on the line. The payment goes through in two minutes.'))
  'grandchild-call' = @('David', @(
    "Grandma, it's me. I know this is a new number, my phone broke.",
    "I need two hundred dollars in Apple gift cards right now, please don't tell Mom.",
    "There's no time for the word, please hurry."))
  'card-details-call' = @('Zira', @(
    "Hi, I'm calling from your bank's security team about suspicious activity on your card.",
    "To verify it's you I need your full card number and the three digits on the back.",
    "Please don't hang up, we need to do this now."))
  'safe-account-call' = @('Zira', @(
    'This is the fraud team. Your account has been compromised.',
    'To protect your money you need to move your savings to a safe account that I will give you.'))
  'harmless-call' = @('Zira', @(
    'Hello, this is First Harbor Bank confirming your appointment tomorrow at three.',
    'This is an appointment reminder. We will never ask for your PIN or your password.',
    'Press 1 to confirm or press 2 to cancel.'))
}
foreach ($name in $clips.Keys) {
  $voiceName, $lines = $clips[$name]
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $s.SelectVoice(($s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -match $voiceName } | Select-Object -First 1).VoiceInfo.Name) } catch { }
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile((Join-Path $out "$name.wav"), $fmt)
  $pb = New-Object System.Speech.Synthesis.PromptBuilder
  $pb.AppendBreak([TimeSpan]::FromSeconds(1.5))
  foreach ($l in $lines) { $pb.AppendText($l); $pb.AppendBreak([TimeSpan]::FromSeconds(1.6)) }
  $s.Speak($pb); $s.SetOutputToNull(); $s.Dispose()
  Write-Host "made $name.wav"
}
