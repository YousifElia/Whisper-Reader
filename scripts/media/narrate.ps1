<#
  Renders the demo video's narration with the real Windows voices.

  Uses System.Speech, which drives the same SAPI engine Chrome uses on
  Windows, at the same integer rate scale -- so "Calm" here is SAPI rate -1,
  exactly what the extension asks for at 0.79x. Every word's position in the
  audio is recorded from SpeakProgress events, which is what lets the video's
  highlighting land on each word as it is actually spoken.

    powershell -NoProfile -File scripts/media/narrate.ps1 <segments.json> <outDir>

  segments.json: [{ "id": "s1", "text": "...", "voice": "Zira", "rate": -1 }]
  Writes <outDir>/<id>.wav and <outDir>/timings.json.
#>
param(
  [Parameter(Mandatory = $true)][string]$SegmentsPath,
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text;

public static class CalmNarrator {
  public static string Render(string text, string voice, int rate, string wavPath) {
    var words = new List<string>();
    var gate = new object();
    using (var synth = new SpeechSynthesizer()) {
      foreach (var installed in synth.GetInstalledVoices()) {
        if (installed.VoiceInfo.Name.IndexOf(voice, StringComparison.OrdinalIgnoreCase) >= 0) {
          synth.SelectVoice(installed.VoiceInfo.Name);
          break;
        }
      }
      synth.Rate = rate;
      synth.Volume = 100;
      // 16 kHz, not higher: SpeakProgress reports AudioPosition as if the
      // output were 16 kHz whatever format is requested. At 24 kHz every word
      // was stamped exactly 1.5x too late -- "we" at 2.98 s, after a pause
      // that ends at 2.01 s in the actual audio -- and the highlighting fell
      // further behind the voice with every word. These voices are 16 kHz
      // natively, so nothing is lost.
      synth.SetOutputToWaveFile(
        wavPath,
        new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
      synth.SpeakProgress += (sender, e) => {
        lock (gate) {
          words.Add(string.Format(CultureInfo.InvariantCulture,
            "{{\"pos\":{0},\"len\":{1},\"ms\":{2}}}",
            e.CharacterPosition, e.CharacterCount,
            (long)e.AudioPosition.TotalMilliseconds));
        }
      };
      synth.Speak(text);
      synth.SetOutputToNull();
    }
    lock (gate) { return "[" + string.Join(",", words) + "]"; }
  }
}
'@

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$segments = Get-Content -Raw -Encoding UTF8 $SegmentsPath | ConvertFrom-Json
$entries = @()
foreach ($segment in $segments) {
  $wav = Join-Path $OutDir ($segment.id + '.wav')
  $words = [CalmNarrator]::Render($segment.text, $segment.voice, [int]$segment.rate, $wav)
  $entries += '"' + $segment.id + '":' + $words
  Write-Output ('rendered ' + $segment.id)
}
$json = '{' + ($entries -join ',') + '}'
[System.IO.File]::WriteAllText((Join-Path $OutDir 'timings.json'), $json, (New-Object System.Text.UTF8Encoding $false))
