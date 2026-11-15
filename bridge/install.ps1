# Installs better-rawmhub-bridge for the current user.
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -AutoStart
param(
  [switch]$AutoStart
)

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'better-rawmhub-bridge.exe'
if (-not (Test-Path $source)) {
  throw "better-rawmhub-bridge.exe was not found next to this script."
}

$target = Join-Path $env:LOCALAPPDATA 'BetterRawmHubBridge'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$exe = Join-Path $target 'better-rawmhub-bridge.exe'
Copy-Item $source $exe -Force

# Start-menu shortcut: the daemon prints its pairing code in a console window,
# so it has to be started by the user, not hidden.
$shell = New-Object -ComObject WScript.Shell
$programs = [Environment]::GetFolderPath('Programs')
$shortcut = $shell.CreateShortcut((Join-Path $programs 'Better RAWM Hub Bridge.lnk'))
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $target
$shortcut.Description = 'HID bridge for Firefox and Safari'
$shortcut.Save()

if ($AutoStart) {
  $startup = [Environment]::GetFolderPath('Startup')
  $auto = $shell.CreateShortcut((Join-Path $startup 'Better RAWM Hub Bridge.lnk'))
  $auto.TargetPath = $exe
  $auto.WorkingDirectory = $target
  $auto.Save()
  Write-Host "Auto-start enabled. Remove it from $startup if you change your mind."
}

Write-Host ""
Write-Host "Installed to $target"
Write-Host "Start it from the Start menu: 'Better RAWM Hub Bridge'."
Write-Host "The window prints a six-digit pairing code the first time a page connects."
Write-Host ""
Write-Host "Windows will warn that the publisher is unknown (the build is not signed)."
Write-Host "Choose More info -> Run anyway, or add $target to Defender exclusions."
