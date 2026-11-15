# Removes everything install.ps1 added for the current user:
# the daemon, both Start-menu shortcuts, the betterrawm:// handler, an optional
# login entry and the config/log folder.
#
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# Nothing else on the machine is touched.

$ErrorActionPreference = 'Continue'

$target = Join-Path $env:LOCALAPPDATA 'BetterRawmHubBridge'
$exe = Join-Path $target 'better-rawmhub-bridge.exe'

Write-Host "Stopping the bridge..."
if (Test-Path $exe) {
  & $exe --stop | Out-Null
  Start-Sleep -Milliseconds 500
}
Get-Process better-rawmhub-bridge -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "Removing the betterrawm:// handler..."
Remove-Item 'HKCU:\Software\Classes\betterrawm' -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Removing shortcuts..."
$programs = [Environment]::GetFolderPath('Programs')
$startup = [Environment]::GetFolderPath('Startup')
foreach ($link in @(
  (Join-Path $programs 'Better RAWM Hub Bridge.lnk'),
  (Join-Path $programs 'Stop Better RAWM Hub Bridge.lnk'),
  (Join-Path $startup 'Better RAWM Hub Bridge.lnk')
)) {
  Remove-Item $link -Force -ErrorAction SilentlyContinue
}

Write-Host "Removing $target..."
Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue

$left = @()
if (Test-Path $target) { $left += $target }
if (Test-Path 'HKCU:\Software\Classes\betterrawm') { $left += 'HKCU\Software\Classes\betterrawm' }
if (Get-Process better-rawmhub-bridge -ErrorAction SilentlyContinue) { $left += 'a running better-rawmhub-bridge process' }

Write-Host ""
if ($left.Count) {
  Write-Host "Some items could not be removed:"
  $left | ForEach-Object { Write-Host "  - $_" }
  Write-Host "Close the bridge (or Task Manager) and run this again."
} else {
  Write-Host "Done. Better RAWM Hub Bridge is gone."
  Write-Host "The web configurator still works in Chrome and Edge over WebHID."
}
Write-Host ""
