param(
    [string]$DataDirectory,
    [Parameter(Mandatory=$true)][string]$ReportPath,
    [string]$Binary = (Join-Path $PSScriptRoot 'target/release/tokenatlas-monitor.exe'),
    [string[]]$AccountIds = @(),
    [ValidateRange(0,8)][int]$ConfiguredPanelCount = 0,
    [switch]$Demo,
    [switch]$HiddenDemo,
    [switch]$KeepOpen,
    [ValidateRange(15,300)][int]$Seconds = 45
)
$ErrorActionPreference = 'Stop'
if (-not ('MonitorProcessTree' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MonitorProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry {
    public uint size,usage,id; public IntPtr heap; public uint module,threads,parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint id);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] Children(uint parent) {
    var result=new List<int>(); var all=new Dictionary<uint,List<uint>>();
    var snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw new Exception("Process snapshot unavailable");
    try {
      var entry=new Entry();entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      if(Process32FirstW(snapshot,ref entry)) do {
        if(!all.ContainsKey(entry.parent)) all[entry.parent]=new List<uint>();
        all[entry.parent].Add(entry.id);
      }while(Process32NextW(snapshot,ref entry));
    }finally{CloseHandle(snapshot);}
    var pending=new Queue<uint>(); var seen=new HashSet<uint>();pending.Enqueue(parent);seen.Add(parent);
    while(pending.Count>0) {
      var current=pending.Dequeue();
      if(!all.ContainsKey(current)) continue;
      foreach(var id in all[current]) if(seen.Add(id)) {result.Add((int)id);pending.Enqueue(id);}
    }
    return result.ToArray();
  }
}
'@
}
$monitorBinary = (Resolve-Path -LiteralPath $Binary).Path
$monitorData = if ($DataDirectory) { [IO.Path]::GetFullPath($DataDirectory) } else {
    if ($Demo) {throw 'Demo requires a separate DataDirectory'}
    Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath))) ([IO.Path]::GetFileNameWithoutExtension($ReportPath)+'-logs')
}
New-Item -ItemType Directory -Path $monitorData -Force | Out-Null
$monitorArgs = @()
if (-not $KeepOpen) {$monitorArgs += @('--exit-after', [string]([math]::Min($Seconds + 2,300)))}
if ($DataDirectory) {$monitorArgs+=@('--data-dir', ('"' + $monitorData + '"'))}
if ($Demo) { $monitorArgs += '--demo' }
if ($HiddenDemo) {
    if (-not $Demo) {throw 'HiddenDemo requires Demo; provider reads are excluded'}
    $monitorArgs += '--measure-hidden'
}
foreach ($id in $AccountIds) {
    if ($id -notmatch '^(?:(?:chatgpt|claude|demo)-[a-zA-Z0-9]+|(?:codex|claude):[a-zA-Z0-9_.-]+)$') { throw 'Invalid account ID' }
    $monitorArgs += @('--select', $id)
}
$monitorWindowStyle = if ($HiddenDemo) {'Hidden'} else {'Normal'}
$monitorProcess = Start-Process -FilePath $monitorBinary -ArgumentList $monitorArgs -WindowStyle $monitorWindowStyle -PassThru -RedirectStandardError (Join-Path $monitorData 'run-errors.log') -RedirectStandardOutput (Join-Path $monitorData 'run-output.log')
$watch = [Diagnostics.Stopwatch]::StartNew()
$samples = [Collections.Generic.List[object]]::new()
$childQueryOk = $true
$children = @()
$lastChildQuery = -1.0
$previousSample = 0.0
while ($watch.Elapsed.TotalSeconds -lt $Seconds -and -not $monitorProcess.HasExited) {
    $monitorProcess.Refresh()
    if ($watch.Elapsed.TotalSeconds - $lastChildQuery -gt 0.5) {
        try { $children = @([MonitorProcessTree]::Children([uint32]$monitorProcess.Id)) }
        catch { $childQueryOk = $false; $children = @() }
        $lastChildQuery = $watch.Elapsed.TotalSeconds
    }
    $childPrivate = 0L
    $childWorkingSet = 0L
    foreach ($child in $children) {
        try {
            $childProcess = [Diagnostics.Process]::GetProcessById([int]$child)
            $childPrivate += $childProcess.PrivateMemorySize64
            $childWorkingSet += $childProcess.WorkingSet64
            $childProcess.Dispose()
        } catch { }
    }
    $sampleAt=$watch.Elapsed.TotalSeconds
    $windowReady=$monitorProcess.MainWindowHandle -ne [IntPtr]::Zero
    $responding=$monitorProcess.Responding
    $samples.Add([pscustomobject]@{
        second = [math]::Round($sampleAt,3)
        sampleGapMilliseconds = [math]::Round(($sampleAt-$previousSample)*1000,2)
        windowReady = $windowReady
        responding = $responding
        privateBytes = $monitorProcess.PrivateMemorySize64
        workingSetBytes = $monitorProcess.WorkingSet64
        cpuSeconds = $monitorProcess.TotalProcessorTime.TotalSeconds
        combinedPrivateBytes = $monitorProcess.PrivateMemorySize64 + $childPrivate
        combinedWorkingSetBytes = $monitorProcess.WorkingSet64 + $childWorkingSet
        children = $children.Count
    })
    $previousSample=$sampleAt
    Start-Sleep -Milliseconds 200
}
if (-not $KeepOpen -and -not $monitorProcess.WaitForExit(10000)) { $monitorProcess.Kill($true); throw 'Monitor did not finish its diagnostic run' }
$idle = @($samples | Where-Object second -ge 8)
$idleCpu = if ($idle.Count -gt 1) { ($idle[-1].cpuSeconds - $idle[0].cpuSeconds) / ($idle[-1].second - $idle[0].second) * 100 } else { $null }
$sampledDuration = if ($samples.Count -gt 0) {$samples[-1].second} else {0}
$quietStartsAt = [math]::Max(8, $sampledDuration - 30)
$quiet = @($samples | Where-Object second -ge $quietStartsAt)
$quietCpu = if ($quiet.Count -gt 1) { ($quiet[-1].cpuSeconds - $quiet[0].cpuSeconds) / ($quiet[-1].second - $quiet[0].second) * 100 } else { $null }
$report = [pscustomobject]@{
    entryPoint = $monitorBinary
    mode = $(if ($HiddenDemo) { 'native hidden window; demo; no provider reads or visible desktop window' } elseif ($Demo) { 'demo; synthetic subscriptions; no provider reads' } else { 'shared published register; read-only; selected subscriptions' })
    selectedAccountCount = $(if ($AccountIds.Count -gt 0) {$AccountIds.Count} else {$null})
    selectionOverrideApplied = $AccountIds.Count -gt 0
    initialConfiguredPanelCount = $(if ($ConfiguredPanelCount -gt 0) {$ConfiguredPanelCount} else {$null})
    usesDefaultAppDataDirectory = -not [bool]$DataDirectory
    requestedDurationSeconds = $Seconds
    sampleDurationSeconds = $sampledDuration
    samplingMilliseconds = 200
    idleStartsAtSecond = 8
    quietTailStartsAtSecond = $quietStartsAt
    interactionNote = 'Post-start averages may include UI interactions; quiet-tail values require no interaction during the last 30 seconds.'
    excludes = 'other processes and main tokenAtlas server; GPU/compositor memory; package size is separate; CPU is percent of one logical core; descendant peak is sampled; the main database is read-only'
    childQuerySucceeded = $childQueryOk
    exitCode = $(if ($monitorProcess.HasExited) {$monitorProcess.ExitCode} else {$null})
    leftRunning = -not $monitorProcess.HasExited
    windowSamples = @($samples | Where-Object windowReady).Count
    nonRespondingWindowSamples = @($samples | Where-Object { $_.windowReady -and -not $_.responding }).Count
    maximumSampleGapMilliseconds = ($samples | Select-Object -Skip 1 | Measure-Object sampleGapMilliseconds -Maximum).Maximum
    rendererDiagnostic = $(if ($HiddenDemo) { Get-Content -LiteralPath (Join-Path $monitorData 'run-output.log') -Raw | ConvertFrom-Json } else {$null})
    idlePrivateMiB = [math]::Round(($idle | Measure-Object privateBytes -Average).Average / 1MB,2)
    idleWorkingSetMiB = [math]::Round(($idle | Measure-Object workingSetBytes -Average).Average / 1MB,2)
    idleOneCoreCpuPercent = $(if ($null -eq $idleCpu) { $null } else { [math]::Round($idleCpu,4) })
    quietTailPrivateMiB = [math]::Round(($quiet | Measure-Object privateBytes -Average).Average / 1MB,2)
    quietTailWorkingSetMiB = [math]::Round(($quiet | Measure-Object workingSetBytes -Average).Average / 1MB,2)
    quietTailOneCoreCpuPercent = $(if ($null -eq $quietCpu) { $null } else { [math]::Round($quietCpu,4) })
    sampledPeakCombinedPrivateMiB = [math]::Round(($samples | Measure-Object combinedPrivateBytes -Maximum).Maximum / 1MB,2)
    sampledPeakCombinedWorkingSetMiB = [math]::Round(($samples | Measure-Object combinedWorkingSetBytes -Maximum).Maximum / 1MB,2)
    samples = $samples
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding utf8
$report | Select-Object mode,exitCode,childQuerySucceeded,windowSamples,nonRespondingWindowSamples,maximumSampleGapMilliseconds,idlePrivateMiB,idleWorkingSetMiB,idleOneCoreCpuPercent,sampledPeakCombinedPrivateMiB,sampledPeakCombinedWorkingSetMiB | ConvertTo-Json
