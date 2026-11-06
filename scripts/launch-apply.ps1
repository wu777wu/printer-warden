# Non-elevated launcher: asks for consent once (UAC), waits for the elevated apply, propagates the result.
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$apply = Join-Path $here 'apply.ps1'
try {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $apply, '-ConfigPath', $ConfigPath, '-ResultPath', $ResultPath)
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
  exit $proc.ExitCode
}
catch {
  $message = $_.Exception.Message
  $payload = [ordered]@{ ok = $false; steps = @(); error = "elevation-cancelled: $message" }
  [IO.File]::WriteAllText($ResultPath, ($payload | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  exit 1223
}
