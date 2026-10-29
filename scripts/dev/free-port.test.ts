import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const windows = process.platform === "win32" ? test : test.skip;
for (const scenario of ["free", "foreign", "other-repo", "owned", "preparation", "other-preparation", "relative-preparation", "forward-slashes", "cim-error", "recycled-pid", "timeout"]) {
  windows(`restart port: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-port-review-"));
    const helper = path.join(import.meta.dir, "free-port.ps1").replaceAll("'", "''");
    const preparation = scenario.includes("preparation");
    const repo = scenario.startsWith("other-") ? "C:\\other" : "C:\\atlas";
    let entry = `${repo}\\${preparation ? "scripts\\dev\\prepare-app.ts" : "src\\server\\api.ts"}`;
    if (scenario === "relative-preparation") entry = "scripts/dev/prepare-app.ts";
    if (scenario === "forward-slashes") entry = entry.replaceAll("\\", "/");
    const accepted = ["free", "owned", "preparation", "forward-slashes"].includes(scenario);
    fs.writeFileSync(path.join(root, "trial.ps1"), `
$global:stopped = @()
function netstat { if ('${scenario}' -ne 'free' -and $global:stopped -notcontains 42424) { '  TCP  127.0.0.1:7331  0.0.0.0:0  LISTENING  42424' } }
function Get-CimInstance {
  param($ClassName, $Filter)
  if ('${scenario}' -eq 'cim-error') { throw 'CIM unavailable' }
  $all = @(
    [pscustomobject]@{ ProcessId=42424; ParentProcessId=42425; CreationDate=1; Name='${scenario === "foreign" ? "other.exe" : "bun.exe"}'; CommandLine='bun.exe "${entry}"${preparation ? "" : " --atlas-server-child"}' },
    [pscustomobject]@{ ProcessId=42425; ParentProcessId=1; CreationDate=1; Name='${preparation ? "powershell.exe" : "bun.exe"}'; CommandLine='bun.exe run src/server/api.ts' },
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
      expect(code, out).toBe(accepted ? 0 : 1);
      if (accepted && scenario !== "free") {
        for (const id of preparation ? [42424, 42426] : [42424, 42425, 42426]) expect(out).toContain(`STOP:${id}`);
        if (preparation) expect(out).not.toContain("STOP:42425");
      } else if (scenario === "timeout") expect(out).toContain("still active");
      else expect(out).not.toContain("STOP:");
      if (scenario === "relative-preparation") expect(out).toContain("Its repository could not be verified");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
}
