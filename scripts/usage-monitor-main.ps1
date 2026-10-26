param([switch]$Check)

function Test-TokenAtlasServerCommand([string]$CommandLine,
    [string]$Entrypoint = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\server\api.ts')) {
    # The official supervisor uses an absolute entrypoint. Other worktrees are separate runs.
    $expected = [regex]::Escape([IO.Path]::GetFullPath($Entrypoint).Replace('/', '\'))
    return $CommandLine.Replace('/', '\') -match ('(?:^|[\s"])' + $expected + '(?:[\s"]|$)') -and
        $CommandLine -match '(?:^|\s)--atlas-server-child(?:\s|$)'
}

function Test-TokenAtlasServerRunning {
    $processes = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction Stop
    return @($processes | Where-Object { Test-TokenAtlasServerCommand $_.CommandLine }).Count -gt 0
}

if ($Check) {
    try {
        $servers = @(Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction Stop | Where-Object { Test-TokenAtlasServerCommand $_.CommandLine })
        @{ running = $servers.Count -gt 0; pid = $(if($servers.Count -eq 1){[int]$servers[0].ProcessId}else{$null}) } | ConvertTo-Json -Compress
    }
    catch { @{ error = 'main-detection-unavailable' } | ConvertTo-Json -Compress; exit 1 }
}
