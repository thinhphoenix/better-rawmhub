# Installs better-rawmhub-bridge for the current user.
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -AutoStart
#
# Adds: Start-menu shortcuts (start / stop), the betterrawm:// protocol so the
# page can start the daemon itself, and optionally a login entry.
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

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut([string]$path, [string]$arguments) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $exe
  $link.Arguments = $arguments
  $link.WorkingDirectory = $target
  $link.Description = 'HID bridge for Firefox and Safari'
  $link.WindowStyle = 7           # minimised: the daemon has no window anyway
  $link.Save()
}

$programs = [Environment]::GetFolderPath('Programs')
New-Shortcut (Join-Path $programs 'Better RAWM Hub Bridge.lnk') '--idle=0'
New-Shortcut (Join-Path $programs 'Stop Better RAWM Hub Bridge.lnk') '--stop'

# betterrawm://start lets the page launch the daemon with one click.
$scheme = 'HKCU:\Software\Classes\betterrawm'
New-Item -Path $scheme -Force | Out-Null
Set-ItemProperty -Path $scheme -Name '(default)' -Value 'URL:Better RAWM Hub Bridge'
Set-ItemProperty -Path $scheme -Name 'URL Protocol' -Value ''
New-Item -Path "$scheme\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$scheme\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""

if ($AutoStart) {
  $startup = [Environment]::GetFolderPath('Startup')
  New-Shortcut (Join-Path $startup 'Better RAWM Hub Bridge.lnk') '--idle=0'
}

# Start it now so the first Connect works without waiting for a login.
Start-Process -FilePath $exe -ArgumentList '--idle=0' -WindowStyle Hidden
Start-Sleep -Milliseconds 400

Write-Host ""
Write-Host "Installed to $target"
Write-Host "Start menu: 'Better RAWM Hub Bridge' / 'Stop Better RAWM Hub Bridge'"
Write-Host "Log:        $target\bridge.log"
Write-Host ""
if ($AutoStart) {
  Write-Host "It will also start with Windows. Remove the Startup shortcut to undo that."
} else {
  Write-Host "It starts when the page asks (betterrawm://), and exits a few minutes after"
  Write-Host "the last tab closes. Re-run with -AutoStart to keep it running at login."
}
Write-Host ""
Write-Host "Windows warns that the publisher is unknown (the build is not signed):"
Write-Host "choose More info -> Run anyway, or add $target to Defender exclusions."
Write-Host ""
Write-Host "To remove it later, run uninstall.ps1 from the same archive."
