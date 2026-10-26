$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
cargo build --locked --release --jobs 2 --manifest-path (Join-Path $projectRoot 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Monitor build failed' }
$packageRoot = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'target/release/tokenatlas-monitor.exe') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot '../../LICENSE') -Destination (Join-Path $packageRoot 'LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $projectRoot 'assets/OFL-IBM-Plex-Mono.txt') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'assets/OFL-IBM-Plex-Sans.txt') -Destination $packageRoot
Write-Output (Join-Path $packageRoot 'tokenatlas-monitor.exe')
