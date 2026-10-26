# Native parser for _dev.bat (Rust R0, docs/source-archive-plan-2026-09-19.md).
#   default   - with Rust + MSVC: build it; otherwise download the binary published for these exact
#               sources (native/tokenatlas-parse/release.json) and check its SHA-256 before use.
#   -Publish  - build with the release flags, upload it as a GitHub release and write release.json.
# A stamp next to the binary records the source hash it was built or downloaded for.
# Run from PowerShell: Git Bash's link.exe shadows the MSVC linker.
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$crate = Join-Path $repoPath 'native/tokenatlas-parse'
$exe = Join-Path $crate 'target/release/tokenatlas-parse.exe'
$stamp = "$exe.version"
$manifestPath = Join-Path $crate 'release.json'
$versionScript = Join-Path $repoPath 'scripts/dev/native-parser-version.ts'

function Query([string]$what) {
    $out = & bun $versionScript $what
    if ($LASTEXITCODE -ne 0) { throw "native-parser-version.ts $what failed" }
    return ([string]$out).Trim()
}
# Exit code of a native command whose output is not wanted; Windows PowerShell 5.1 turns redirected
# stderr into errors, which 'Stop' would throw.
function Exit-Code([scriptblock]$command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $command *> $null; return $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
}
function Find-Cargo {
    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not $cargo -or -not (Test-Path -LiteralPath $vswhere)) { return $null }
    $msvc = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $msvc) { return $null }
    return $cargo.Source
}
function Build-Parser([string]$cargo, [string]$rustflags, [switch]$Locked) {
    Write-Host '[parse] Building native parser...'
    Push-Location $repoPath
    $previousRustFlags = $env:RUSTFLAGS
    $previousEncodedRustFlags = $env:CARGO_ENCODED_RUSTFLAGS
    try {
        # Inherited machine-specific flags must not leak into the distributed binary.
        $env:RUSTFLAGS = $rustflags
        Remove-Item Env:CARGO_ENCODED_RUSTFLAGS -ErrorAction SilentlyContinue
        $cargoArgs = @('build', '--release', '--manifest-path', 'native/tokenatlas-parse/Cargo.toml')
        if ($Locked) { $cargoArgs += '--locked' }
        & $cargo @cargoArgs | Out-Host
        return $LASTEXITCODE
    } finally {
        $env:RUSTFLAGS = $previousRustFlags
        $env:CARGO_ENCODED_RUSTFLAGS = $previousEncodedRustFlags
        Pop-Location
    }
}
function Sha256([string]$file) {
    $stream = [IO.File]::OpenRead($file)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Gh-Ready {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $false }
    return (Exit-Code { gh auth status }) -eq 0
}

# Reuse the HTTPS Git login on a fresh checkout without requiring a separate gh installation.
function Download-WithGitCredential($manifest, [string]$file) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
    if ($manifest.repo -notmatch '^[\w.-]+/[\w.-]+$') { return $false }
    $previousPrompt = $env:GIT_TERMINAL_PROMPT
    $previousInteractive = $env:GCM_INTERACTIVE
    try {
        $env:GIT_TERMINAL_PROMPT = '0'
        $env:GCM_INTERACTIVE = 'Never'
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $password = @()
            # Some token-based Git askpass helpers require the conventional username upfront.
            foreach ($username in @('', "username=x-access-token`n")) {
                $reply = "protocol=https`nhost=github.com`npath=$($manifest.repo).git`n$username`n" |
                    & git -c credential.interactive=never credential fill 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $password = @($reply | Where-Object { $_.StartsWith('password=') })
                    if ($password.Count -eq 1) { break }
                }
            }
        } finally { $ErrorActionPreference = $previousPreference }
        if ($password.Count -ne 1) { return $false }
        $headers = @{ Authorization = 'Bearer ' + $password[0].Substring(9); Accept = 'application/vnd.github+json'; 'User-Agent' = 'tokenAtlas-dev' }
        $tag = [Uri]::EscapeDataString($manifest.tag)
        $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$($manifest.repo)/releases/tags/$tag"
        $asset = @($release.assets | Where-Object { $_.name -eq $manifest.asset })
        if ($asset.Count -ne 1 -or [string]$asset[0].id -notmatch '^\d+$') { return $false }
        $headers.Accept = 'application/octet-stream'
        Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/$($manifest.repo)/releases/assets/$($asset[0].id)" -OutFile $file
        return $true
    } catch { return $false }
    finally {
        $env:GIT_TERMINAL_PROMPT = $previousPrompt
        $env:GCM_INTERACTIVE = $previousInteractive
    }
}

$sourceHash = Query 'hash'
$rustflags = Query 'rustflags'
$asset = Query 'asset'
$cargo = Find-Cargo

if ($Publish) {
    if (-not $cargo) { throw 'Publishing needs Rust and the MSVC build tools.' }
    if (-not (Gh-Ready)) { throw 'Publishing needs the GitHub CLI (gh), signed in.' }
    $tag = Query 'tag'
    $repo = ([string](& gh repo view --json nameWithOwner -q .nameWithOwner)).Trim()
    $head = ([string](& git -C $repoPath rev-parse HEAD)).Trim()
    if (-not (& git -C $repoPath branch -r --contains $head)) { throw "Push $head first: the release tag points at it." }
    $dir = Join-Path $crate 'target/publish'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $upload = Join-Path $dir $asset
    if ((Exit-Code { gh release view $tag --repo $repo }) -eq 0) {
        # Builds are not byte-reproducible: the published binary stays the reference.
        Write-Host "[parse] $tag is already published; reading its checksum."
        & gh release download $tag --repo $repo --pattern $asset --dir $dir --clobber
        if ($LASTEXITCODE -ne 0) { throw "Cannot download $asset from $tag." }
        $sha = Sha256 $upload
    } else {
        if ((Build-Parser $cargo $rustflags -Locked) -ne 0) { throw 'cargo build failed.' }
        Copy-Item -LiteralPath $exe -Destination $upload -Force
        $sha = Sha256 $upload
        $notes = "Native parser built from native/tokenatlas-parse sources $sourceHash with RUSTFLAGS $rustflags. SHA-256 $sha. _dev.bat downloads it on machines without Rust."
        & gh release create $tag $upload --repo $repo --target $head --title "Native parser $tag" --notes $notes --latest=false
        if ($LASTEXITCODE -ne 0) { throw 'gh release create failed.' }
        Set-Content -LiteralPath $stamp -Value $sourceHash -Encoding ascii
    }
    $manifest = [ordered]@{ source_hash = $sourceHash; tag = $tag; repo = $repo; asset = $asset; sha256 = $sha }
    [IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json) -replace "`r`n", "`n") + "`n")
    Write-Host "[parse] Published $tag; commit native/tokenatlas-parse/release.json."
    exit 0
}

if ($cargo) {
    $code = Build-Parser $cargo $rustflags
    if ($code -eq 0) { Set-Content -LiteralPath $stamp -Value $sourceHash -Encoding ascii }
    exit $code
}

if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $sourceHash)) {
    Write-Host '[parse] Native parser matches its sources.'
    exit 0
}

# Without Rust: the binary published for these sources, verified against the checksum in the repository.
$manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
$failure = $null
if (-not $manifest -or $manifest.source_hash -ne $sourceHash) {
    $failure = 'no published binary matches these parser sources'
} else {
    Write-Host "[parse] Downloading the native parser $($manifest.tag)..."
    $dir = Join-Path $crate 'target/download'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $file = Join-Path $dir $manifest.asset
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    try {
        if (Gh-Ready) {
            [void](Exit-Code { gh release download $manifest.tag --repo $manifest.repo --pattern $manifest.asset --dir $dir --clobber })
        } else {
            # A public repository needs no sign-in; a private one needs gh.
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            try {
                Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$($manifest.repo)/releases/download/$($manifest.tag)/$($manifest.asset)" -OutFile $file
            } catch {
                [void](Download-WithGitCredential $manifest $file)
            }
        }
    } catch { }
    if (-not (Test-Path -LiteralPath $file)) {
        $failure = 'download failed (for a private repository sign in with HTTPS Git, or install the GitHub CLI and run gh auth login)'
    } elseif ((Sha256 $file) -ne $manifest.sha256) {
        Remove-Item -LiteralPath $file -Force
        $failure = 'the downloaded file does not match the SHA-256 in release.json and was deleted'
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $exe) | Out-Null
        Move-Item -LiteralPath $file -Destination $exe -Force
        Set-Content -LiteralPath $stamp -Value $sourceHash -Encoding ascii
        Write-Host '[parse] Native parser downloaded and verified.'
        exit 0
    }
}
if (Test-Path -LiteralPath $exe) {
    Write-Host "[parse] WARNING: $failure; using the existing native parser, which may be older than its sources."
    exit 0
}
Write-Host "[parse] $failure."
exit 1
