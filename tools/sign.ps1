# Has Mozilla sign Mor's extension for self-distribution (unlisted on addons.mozilla.org), and puts the signed
# Mor.xpi beside "Install Mor.cmd", which then installs it in Firefox. Run through "tools\sign.cmd".
#
# Needs your AMO API credentials (https://addons.mozilla.org/developers/addon/api/key/). They're asked for here, or
# read from a .amo-keys file in Mor's folder (two lines: the issuer, then the secret; git ignores the file). They're
# only sent to Mozilla. Each version number can be signed once: raise "version" in extension\manifest.json first.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Extension = Join-Path $Root "extension"
$Artifacts = Join-Path $Root "web-ext-artifacts"
$KeysFile = Join-Path $Root ".amo-keys"

function Fail($text) { Write-Host ""; Write-Host "Signing failed: $text" -ForegroundColor Red; exit 1 }

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Fail "Node.js is needed (https://nodejs.org), or run Install Mor.cmd first" }

$version = (Get-Content (Join-Path $Extension "manifest.json") -Raw | ConvertFrom-Json).version
Write-Host "Signing Mor $version (unlisted)" -ForegroundColor Magenta

if (Test-Path $KeysFile) {
    $lines = @(Get-Content $KeysFile | Where-Object { $_.Trim() })
    if ($lines.Count -lt 2) { Fail ".amo-keys needs two lines: the issuer (JWT issuer), then the secret" }
    $key, $secret = $lines[0].Trim(), $lines[1].Trim()
} else {
    Write-Host "Your AMO API credentials, from https://addons.mozilla.org/developers/addon/api/key/"
    $key = (Read-Host "JWT issuer").Trim()
    $secure = Read-Host "JWT secret" -AsSecureString
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
    if (-not $key -or -not $secret) { Fail "both the issuer and the secret are needed" }
    $save = Read-Host "Keep them in .amo-keys for next time? (y/n)"
    if ($save -eq "y") { Set-Content -Path $KeysFile -Value @($key, $secret) -Encoding ASCII }
}

# the credentials go to web-ext through its environment, never on a command line other programs can read
$env:WEB_EXT_API_KEY = $key
$env:WEB_EXT_API_SECRET = $secret
New-Item -ItemType Directory -Force $Artifacts | Out-Null
$before = @(Get-ChildItem $Artifacts -Filter *.xpi | ForEach-Object FullName)
& npx --yes web-ext@8 sign --channel=unlisted --source-dir "$Extension" --artifacts-dir "$Artifacts" --ignore-files "tests/**" --approval-timeout 900000
$code = $LASTEXITCODE
Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
if ($code -ne 0) { Fail "web-ext stopped with code $code (its message is above). A version that was signed before must be raised in extension\manifest.json" }

$signed = Get-ChildItem $Artifacts -Filter *.xpi | Where-Object { $before -notcontains $_.FullName } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $signed) { Fail "Mozilla didn't hand back a signed file" }
Copy-Item $signed.FullName (Join-Path $Root "Mor.xpi") -Force
Write-Host ""
Write-Host "Signed: Mor.xpi is ready. Run Install Mor.cmd (or open Mor.xpi in Firefox) to install it." -ForegroundColor Green
