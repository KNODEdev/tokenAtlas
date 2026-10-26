param(
    [string]$Base = 'HEAD'
)

$ErrorActionPreference = 'Stop'
$version = '0.9.13'
$repository = Split-Path -Parent $PSScriptRoot

# Use an audited cached package without downloading or running npm install hooks.
$cacheDirectory = (& npm config get cache).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Could not resolve the npm cache directory.'
}
$packageDirectory = $null
$npxDirectory = Join-Path $cacheDirectory '_npx'
if (Test-Path -LiteralPath $npxDirectory) {
    foreach ($entry in Get-ChildItem -LiteralPath $npxDirectory -Directory) {
        $candidate = Join-Path $entry.FullName 'node_modules/react-doctor'
        $manifestPath = Join-Path $candidate 'package.json'
        if (Test-Path -LiteralPath $manifestPath) {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            if ($manifest.name -eq 'react-doctor' -and $manifest.version -eq $version) {
                $packageDirectory = $candidate
                break
            }
        }
    }
}
if (-not $packageDirectory) {
    throw "React Doctor $version is not cached. Install the reviewed version separately before running this offline check."
}

$previousTelemetry = $env:REACT_DOCTOR_NO_TELEMETRY
try {
    $env:REACT_DOCTOR_NO_TELEMETRY = '1'
    Push-Location -LiteralPath $repository
    try {
        # Both flags are needed: Socket dependency lookups are separate from telemetry.
        & node (Join-Path $packageDirectory 'bin/react-doctor.js') . `
            --verbose --scope changed --base $Base --include-untracked `
            --no-telemetry --no-supply-chain --yes --no-color
        $scanExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    $env:REACT_DOCTOR_NO_TELEMETRY = $previousTelemetry
}
exit $scanExit
