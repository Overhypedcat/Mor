# Removes what Mor's installer put on this PC outside Mor's folder (run through "Uninstall Mor.cmd"): Firefox's
# registration of the helper, and Mor's data (VPN servers, song copies, the tunnel program, the log). The extension
# itself is removed in Firefox (Add-ons and themes > Extensions > Mor > Remove), and Mor's folder by deleting it.
$ErrorActionPreference = "Continue"
Get-Process MorHelper, wireproxy -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ($_.Path -like "$env:LOCALAPPDATA\Mor\*" -or $_.Path -like "$(Split-Path -Parent $PSScriptRoot)\*")
} | Stop-Process -Force
Remove-Item "HKCU:\Software\Mozilla\NativeMessagingHosts\mor_helper" -Recurse -Force -ErrorAction SilentlyContinue
foreach ($folder in @((Join-Path $env:LOCALAPPDATA "Mor"), (Join-Path $env:APPDATA "Mor"))) {
    if (Test-Path $folder) { Remove-Item $folder -Recurse -Force }
}
$failed = @((Join-Path $env:LOCALAPPDATA "Mor"), (Join-Path $env:APPDATA "Mor")) | Where-Object { Test-Path $_ }
if ($failed) {
    Write-Host "Couldn't remove $($failed -join ', '): close Firefox and run this again." -ForegroundColor Red
    exit 1
}
Write-Host "Mor's helper and data are removed. Remove the extension in Firefox, then delete this folder." -ForegroundColor Green
