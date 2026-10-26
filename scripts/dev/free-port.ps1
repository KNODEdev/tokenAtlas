# Stops whatever still listens on the app port (a previous _dev.bat run) and waits until the port is free.
# Kills the whole process tree (bun run serve -> server -> native parser workers) and never blocks without
# a limit: a server caught in a long SQLite write can take seconds to die, so progress is printed while waiting.
param([Parameter(Mandatory)][int]$Port, [int]$TimeoutSec = 30)

# netstat, not Get-NetTCPConnection: the latter goes through WMI and takes ~4 s per call here.
function Get-Listeners {
  @(netstat -ano -p TCP; netstat -ano -p TCPv6) |
    ForEach-Object { $f = -split $_; if ($f.Count -ge 5 -and $f[3] -eq 'LISTENING' -and $f[1] -match ":$Port$") { [int]$f[4] } } |
    Where-Object { $_ -gt 0 } | Select-Object -Unique
}

function Get-Tree([int]$Root, $All) {
  $ids = @($Root)
  foreach ($child in $All | Where-Object { $_.ParentProcessId -eq $Root }) { $ids += Get-Tree $child.ProcessId $All }
  $ids
}

$listeners = @(Get-Listeners)
if ($listeners.Count -eq 0) { Write-Host "[OK] Port $Port free."; exit 0 }

$all = @(Get-CimInstance Win32_Process)
$targets = @()
foreach ($id in $listeners) {
  $proc = $all | Where-Object { $_.ProcessId -eq $id }
  # The listener is the server; its parent "bun run serve" would otherwise linger in the old window.
  $parent = $all | Where-Object { $_.ProcessId -eq $proc.ParentProcessId -and $_.Name -eq 'bun.exe' }
  $root = if ($parent) { $parent.ProcessId } else { $id }
  Write-Host "    stopping previous server: PID $id ($($proc.Name)), tree from PID $root"
  $targets += Get-Tree $root $all
}
$targets = @($targets | Select-Object -Unique)
# Stop-Process issues TerminateProcess and returns; waiting is done below with a limit.
foreach ($id in $targets) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ($true) {
  $alive = @($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($alive.Count -eq 0 -and @(Get-Listeners).Count -eq 0) { Write-Host "[OK] Port $Port free."; exit 0 }
  if ((Get-Date) -gt $deadline) {
    Write-Host "[X] Port $Port still held after $TimeoutSec s; process(es) not exiting: $($alive -join ', ')."
    Write-Host "    Close the previous tokenAtlas window or end those PIDs in Task Manager, then run _dev.bat again."
    exit 1
  }
  Write-Host "    waiting for PID(s) $($alive -join ', ') to exit..."
  Start-Sleep -Seconds 2
}
