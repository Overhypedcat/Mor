# Sets Mor up on this PC (run through "Install Mor.cmd"): the helper's Python environment, the tunnel program,
# the windowless helper launcher, Firefox's registration of the helper, and then the extension itself in Firefox.
# Safe to run again: it repairs or updates what's there. Everything stays in this folder and in your user account
# (no admin rights, nothing system-wide).
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $Root "helper"
$Venv = Join-Path $Helper ".venv"
$Data = Join-Path $env:LOCALAPPDATA "Mor"
$HostName = "mor_helper"
$ExtensionId = "mor@overhypedcat"
# the tunnel program for region-locked qualities: pinned, and checked against the checksum published with its
# release (github.com/windtf/wireproxy)
$WireproxyUrl = "https://github.com/windtf/wireproxy/releases/download/v1.1.3/wireproxy_windows_amd64.tar.gz"
$WireproxySha256 = "bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f"

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Magenta }
function Fail($text) { Write-Host ""; Write-Host "Mor couldn't be set up: $text" -ForegroundColor Red; exit 1 }

function Find-Python {
    foreach ($candidate in @(@("py", "-3"), @("python"))) {
        try {
            $exe = $candidate[0]
            $pyArgs = @($candidate | Select-Object -Skip 1) + @("-c", "import sys; print(sys.version_info >= (3, 10)); print(sys.executable)")
            $out = & $exe @pyArgs 2>$null
            if ($LASTEXITCODE -eq 0 -and $out[0] -eq "True") { return $out[1] }
        } catch { }
    }
    return $null
}

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Step "Python"
$Python = Find-Python
if (-not $Python) {
    Write-Host "Python 3.10 or newer isn't installed: installing it with winget"
    winget install --id Python.Python.3.13 --exact --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $Python = Find-Python
    if (-not $Python) { Fail "Python couldn't be installed. Install it from https://www.python.org/downloads/ and run this again." }
}
Write-Host "Using $Python"

Step "Node.js (YouTube's song downloads need a JavaScript runtime)"
if (-not ((Get-Command node -ErrorAction SilentlyContinue) -or (Get-Command deno -ErrorAction SilentlyContinue))) {
    winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js couldn't be installed: the music filter will say so when it needs it. Get it from https://nodejs.org" -ForegroundColor Yellow
    }
} else { Write-Host "Found" }

Step "The helper's Python environment"
if (-not (Test-Path (Join-Path $Venv "Scripts\python.exe"))) {
    & $Python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { Fail "the Python environment couldn't be made" }
}
$VenvPython = Join-Path $Venv "Scripts\python.exe"
& $VenvPython -m pip install --disable-pip-version-check --upgrade -e $Helper
if ($LASTEXITCODE -ne 0) { Fail "the helper's packages couldn't be installed (check the internet connection)" }

Step "The tunnel program (wireproxy)"
$Wireproxy = Join-Path $Data "bin\wireproxy.exe"
if (-not (Test-Path $Wireproxy)) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mor-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        $archive = Join-Path $tmp "wireproxy.tar.gz"
        Invoke-WebRequest -Uri $WireproxyUrl -OutFile $archive -UseBasicParsing
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = -join ($sha.ComputeHash([IO.File]::ReadAllBytes($archive)) | ForEach-Object { $_.ToString("x2") })
        if ($hash -ne $WireproxySha256) { Fail "the tunnel program's download isn't the one expected (checksum $hash)" }
        & (Join-Path $env:WINDIR "System32\tar.exe") -xzf $archive -C $tmp
        $exe = Get-ChildItem $tmp -Recurse -Filter wireproxy.exe | Select-Object -First 1
        if (-not $exe) { Fail "the tunnel program's download has no wireproxy.exe in it" }
        New-Item -ItemType Directory -Force (Split-Path $Wireproxy) | Out-Null
        Copy-Item $exe.FullName $Wireproxy -Force
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "Ready"

Step "The helper's launcher"
$Csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$Launcher = Join-Path $Helper "MorHelper.exe"
if (-not (Test-Path $Csc)) { Fail ".NET Framework 4's C# compiler is missing ($Csc)" }
$Built = Join-Path ([IO.Path]::GetTempPath()) ("MorHelper-" + [Guid]::NewGuid() + ".exe")
& $Csc /nologo /target:winexe /optimize "/out:$Built" (Join-Path $Helper "launcher\MorHelper.cs")
if ($LASTEXITCODE -ne 0) { Fail "the helper's launcher couldn't be built" }
try {
    Move-Item $Built $Launcher -Force
} catch {
    Remove-Item $Built -ErrorAction SilentlyContinue
    # Firefox has the helper running: the launcher there is the same program, and the helper's code (what changes
    # between versions) is read from this folder at its next start
    if (-not (Test-Path $Launcher)) { Fail "the helper's launcher couldn't be put in place: $($_.Exception.Message)" }
    Write-Host "The helper is running, so its launcher stays as it is (it works the same)"
}

Step "Telling Firefox where the helper is"
New-Item -ItemType Directory -Force $Data | Out-Null
$Manifest = Join-Path $Data "$HostName.json"
@{ name = $HostName; description = "Mor's helper"; path = $Launcher; type = "stdio"; allowed_extensions = @($ExtensionId) } |
    ConvertTo-Json | ForEach-Object { [IO.File]::WriteAllText($Manifest, $_, (New-Object Text.UTF8Encoding $false)) }
$Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
New-Item -Force $Key | Out-Null
Set-ItemProperty -Path $Key -Name "(default)" -Value $Manifest
Write-Host "Registered"

Step "The extension"
$Xpi = Get-ChildItem $Root -Filter "Mor*.xpi" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Xpi) {
    # the signed extension for this version of Mor, from its GitHub release (it isn't kept in the repository)
    $Version = (Get-Content (Join-Path $Root "extension\manifest.json") -Raw | ConvertFrom-Json).version
    try {
        $Releases = Invoke-RestMethod -Uri "https://api.github.com/repos/Overhypedcat/Mor/releases" -UseBasicParsing
        $Asset = $Releases | Where-Object { $_.tag_name -eq "v$Version" } | ForEach-Object { $_.assets } |
            Where-Object { $_.name -like "*.xpi" } | Select-Object -First 1
        if ($Asset) {
            $Target = Join-Path $Data "Mor-$Version.xpi"
            Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Target -UseBasicParsing
            $Xpi = Get-Item $Target
        } else {
            Write-Host "Mor $Version's signed extension isn't on GitHub yet." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Couldn't download Mor's signed extension from GitHub: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}
$Firefox = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe" -ErrorAction SilentlyContinue).'(default)'
if (-not $Firefox) { $Firefox = Join-Path $env:ProgramFiles "Mozilla Firefox\firefox.exe" }
if (-not (Test-Path $Firefox)) { Fail "Firefox isn't installed" }
if ($Xpi) {
    Write-Host "Firefox opens now and asks to add Mor: press Add."
    Start-Process $Firefox -ArgumentList "`"$($Xpi.FullName)`""
} else {
    Write-Host "To add the extension without it: in Firefox open about:debugging, This Firefox, Load Temporary Add-on,"
    Write-Host "and pick extension\manifest.json (it stays until Firefox closes)."
}

Write-Host ""
Write-Host "Mor is set up." -ForegroundColor Green
