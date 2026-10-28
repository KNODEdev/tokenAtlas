import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const windows = process.platform === "win32" ? test : test.skip;
for (const scenario of ["free", "foreign", "other-repo", "owned", "cim-error", "recycled-pid", "timeout"]) {
  windows(`restart port: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-port-review-"));
    const helper = path.join(import.meta.dir, "free-port.ps1").replaceAll("'", "''");
    const entry = scenario === "other-repo" ? "C:\\other\\src\\server\\api.ts" : "C:\\atlas\\src\\server\\api.ts";
    fs.writeFileSync(path.join(root, "trial.ps1"), `
$global:stopped = @()
function netstat { if ('${scenario}' -ne 'free' -and $global:stopped -notcontains 42424) { '  TCP  127.0.0.1:7331  0.0.0.0:0  LISTENING  42424' } }
function Get-CimInstance {
  param($ClassName, $Filter)
  if ('${scenario}' -eq 'cim-error') { throw 'CIM unavailable' }
  $all = @(
    [pscustomobject]@{ ProcessId=42424; ParentProcessId=42425; CreationDate=1; Name='${scenario === "foreign" ? "other.exe" : "bun.exe"}'; CommandLine='bun.exe "${entry}" --atlas-server-child' },
    [pscustomobject]@{ ProcessId=42425; ParentProcessId=1; CreationDate=1; Name='bun.exe'; CommandLine='bun.exe run src/server/api.ts' },
    [pscustomobject]@{ ProcessId=42426; ParentProcessId=42424; CreationDate=1; Name='parser.exe'; CommandLine='parser.exe' }
  )
  if ($Filter) {
    if ('${scenario}' -eq 'recycled-pid') { $all | ForEach-Object { $_.CreationDate = 2 } }
    $all | Where-Object { $Filter -eq "ProcessId = $($_.ProcessId)" }
  } else { $all }
}
function Get-Process { param($Id) if ('${scenario}' -eq 'timeout') { [pscustomobject]@{ Id=$Id } } }
function Stop-Process { param($Id, [switch]$Force) $global:stopped += $Id; Write-Host "STOP:$Id" }
& '${helper}' -Port 7331 -ProjectRoot C:\\atlas -TimeoutSec 1
exit $LASTEXITCODE
`);
    try {
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "trial.ps1")], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(err).toBe("");
      expect(code, out).toBe(["free", "owned"].includes(scenario) ? 0 : 1);
      if (scenario === "owned") {
        for (const id of [42424, 42425, 42426]) expect(out).toContain(`STOP:${id}`);
      } else if (scenario === "timeout") expect(out).toContain("still active");
      else expect(out).not.toContain("STOP:");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
}
