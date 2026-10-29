param(
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [Parameter(Mandatory)][string]$ProjectRoot,
    [ValidateRange(1, 120)][int]$TimeoutSec = 30
)
$ErrorActionPreference = 'Stop'

function Get-Listeners {
    @(netstat -ano -p TCP; netstat -ano -p TCPv6) |
        ForEach-Object { $f = -split $_; if ($f.Count -ge 5 -and $f[3] -eq 'LISTENING' -and $f[1] -match ":$Port$") { [int]$f[4] } } |
        Where-Object { $_ -gt 0 } | Select-Object -Unique
}
function Get-Tree([int]$Root, $All) {
    $Root
    foreach ($child in $All | Where-Object { $_.ParentProcessId -eq $Root }) { Get-Tree $child.ProcessId $All }
}

try {
    $listeners = @(Get-Listeners)
    if ($listeners.Count -eq 0) { Write-Host "[OK] Port $Port free."; exit 0 }
    # Require the complete entrypoint argument, not a matching directory substring.
    $entryPatterns = @('src\server\api.ts', 'scripts\dev\prepare-app.ts') | ForEach-Object {
        $entry = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $_))
        # Windows accepts either separator in an absolute entrypoint.
        $escaped = [regex]::Escape($entry).Replace('\\', '[/\\]')
        '(?:^|\s)(?:"' + $escaped + '"|' + $escaped + ')(?=\s|$)'
    }
    $entryPattern = $entryPatterns -join '|'
    $all = @(Get-CimInstance Win32_Process)
    $targets = @()
    foreach ($id in $listeners) {
        $server = $all | Where-Object { $_.ProcessId -eq $id }
        if (!$server -or $server.Name -ne 'bun.exe' -or $server.CommandLine -notmatch $entryPattern) {
            if ($server -and $server.Name -eq 'bun.exe' -and $server.CommandLine -match '\s(?:run\s+)?"?scripts[/\\]dev[/\\]prepare-app\.ts"?\s*$') {
                throw "Port $Port is held by a preparation process (PID $id) launched with a relative path. Check its startup error and close that preparation window before retrying. Its repository could not be verified; no process was stopped."
            }
            throw "Port $Port belongs to an unrecognized process (PID $id). No process was stopped."
        }
        # The child has an absolute entrypoint; its supervisor uses a relative one.
        $parent = $all | Where-Object { $_.ProcessId -eq $server.ParentProcessId }
        $root = $id
        if ($parent -and $parent.Name -eq 'bun.exe' -and
            ($parent.CommandLine -match $entryPattern -or $parent.CommandLine -match '\srun\s+"?src[/\\]server[/\\]api\.ts"?\s*$')) {
            $root = $parent.ProcessId
        }
        $targets += @(Get-Tree $root $all)
    }
    # Validate every listener before stopping anything; reject recycled PIDs.
    foreach ($id in @($targets | Select-Object -Unique)) {
        $expected = $all | Where-Object { $_.ProcessId -eq $id }
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $id"
        if (!$current) { continue }
        if ($current.CreationDate -ne $expected.CreationDate -or $current.CommandLine -ne $expected.CommandLine) {
            throw "PID $id changed during port cleanup. Retry _dev.bat."
        }
        Write-Host "    stopping previous tokenAtlas process: PID $id"
        try { Stop-Process -Id $id -Force } catch {
            # A supervisor may have already stopped its child.
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw }
        }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $alive = @($targets | Select-Object -Unique | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($alive.Count -eq 0 -and @(Get-Listeners).Count -eq 0) { break }
        if ((Get-Date) -ge $deadline) { throw "Port $Port or previous tokenAtlas processes still active after $TimeoutSec seconds. Retry _dev.bat after they stop." }
        Start-Sleep -Milliseconds 250
    }
    Write-Host "[OK] Port $Port free."
    exit 0
} catch {
    Write-Host "[X] $($_.Exception.Message)"
    exit 1
}
