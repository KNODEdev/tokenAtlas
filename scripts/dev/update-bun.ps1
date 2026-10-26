param([Parameter(Mandatory = $true)][string]$BunBin)
$ErrorActionPreference = 'Stop'
$stagingRoot = $null
$previousInstall = $env:BUN_INSTALL
$backup = $null
$sibling = $null
function Get-BunDigest([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($hash.ComputeHash($stream)) }
    finally { $hash.Dispose(); $stream.Dispose() }
}
try {
    $BunBin = [IO.Path]::GetFullPath($BunBin)
    $target = Join-Path $BunBin 'bun.exe'
    $release = Invoke-RestMethod 'https://api.github.com/repos/oven-sh/bun/releases/latest'
    if ($release.tag_name -notmatch '^bun-v(\d+\.\d+\.\d+)$' -or $release.prerelease) {
        throw 'Cannot resolve the official stable Bun release.'
    }
    $version = $Matches[1]
    if (Test-Path -LiteralPath $target) {
        $current = $null
        try { $current = & $target --version } catch { Write-Host '[0b] Replacing an unreadable Bun installation...' }
        if ($current -and $LASTEXITCODE -eq 0 -and $current.Trim() -eq $version) {
            Write-Host "[OK] Bun $version is current."
            exit 0
        }
    }
    Write-Host "[0b] Installing stable Bun $version..."
    $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $stagingRoot = Join-Path $taskTempRoot ('tokenatlas-bun-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $stagingRoot | Out-Null
    $env:BUN_INSTALL = $stagingRoot
    $installer = [scriptblock]::Create((Invoke-RestMethod 'https://bun.sh/install.ps1'))
    & $installer -Version $version -NoPathUpdate -NoRegisterInstallation -NoCompletions | Out-Host
    $candidate = Join-Path $stagingRoot 'bin\bun.exe'
    if (-not (Test-Path -LiteralPath $candidate)) { throw 'Official Bun installer did not produce an executable.' }
    $downloadedVersion = & $candidate --version
    if ($LASTEXITCODE -ne 0 -or $downloadedVersion.Trim() -ne $version) { throw 'Downloaded Bun failed version verification.' }
    New-Item -ItemType Directory -Path $BunBin -Force | Out-Null
    # Cross-volume copies finish and are verified before the existing executable is retired.
    $sibling = Join-Path $BunBin ('bun.pending-' + [guid]::NewGuid() + '.exe')
    Copy-Item -LiteralPath $candidate -Destination $sibling
    if ((Get-BunDigest $candidate) -ne (Get-BunDigest $sibling)) { throw 'Bun installation copy differs from its verified download.' }
    if (Test-Path -LiteralPath $target) {
        $backup = Join-Path $BunBin ('bun.previous-' + [guid]::NewGuid() + '.exe')
        Move-Item -LiteralPath $target -Destination $backup
    }
    try {
        Move-Item -LiteralPath $sibling -Destination $target
        $sibling = $null
    } catch {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        if ($backup) { Move-Item -LiteralPath $backup -Destination $target; $backup = $null }
        throw
    }
    if ($backup) {
        # A running process may still hold the old executable; never terminate it for an update.
        Remove-Item -LiteralPath $backup -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] Bun $version installed."
    exit 0
} catch {
    Write-Host "[X] Bun update failed: $($_.Exception.Message)"
    exit 1
} finally {
    $env:BUN_INSTALL = $previousInstall
    if ($sibling) { Remove-Item -LiteralPath $sibling -Force -ErrorAction SilentlyContinue }
    if ($stagingRoot) {
        $resolvedStage = [IO.Path]::GetFullPath($stagingRoot)
        if ([IO.Path]::GetDirectoryName($resolvedStage).TrimEnd('\') -eq $taskTempRoot.TrimEnd('\') -and
            [IO.Path]::GetFileName($resolvedStage) -match '^tokenatlas-bun-[0-9a-f-]{36}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
