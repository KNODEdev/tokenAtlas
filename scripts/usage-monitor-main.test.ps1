$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'usage-monitor-main.ps1')
$cases = @(
    @{Command='bun.exe H:\repo\src\server\api.ts --atlas-server-child';Expected=$true},
    @{Command='"C:\Program Files\bun.exe" "H:\repo with spaces\src\server\api.ts" --atlas-server-child';Expected=$true},
    @{Command='bun src/server/api.ts --atlas-server-child';Expected=$false},
    @{Command='bun src/server/api.ts';Expected=$false},
    @{Command='codex app-server';Expected=$false},
    @{Command='bun test src/server/api.test.ts --atlas-server-child';Expected=$false},
    @{Command='bun other/api.ts --atlas-server-child';Expected=$false},
    @{Command='bun H:\repo\src\server\api.ts --atlas-server-child-other';Expected=$false},
    @{Command='bun H:\repo\TMP\worktrees\trial\src\server\api.ts --atlas-server-child';Expected=$false},
    @{Command='bun H:\another-repo\src\server\api.ts --atlas-server-child';Expected=$false},
    @{Command='bun H:/repo/src/server/api.ts --atlas-server-child';Expected=$true}
)
foreach ($case in $cases) {
    $entrypoint = if ($case.Command -like '*repo with spaces*') { 'H:\repo with spaces\src\server\api.ts' } else { 'H:\repo\src\server\api.ts' }
    if ((Test-TokenAtlasServerCommand $case.Command $entrypoint) -ne $case.Expected) { throw ('Detector mismatch: ' + $case.Command) }
}
Write-Output ('PASS: {0} process identity cases' -f $cases.Count)
