import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const windows = test.skipIf(process.platform !== "win32");
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

for (const scenario of ["public", "git login", "token login", "no login", "bad checksum"] as const) {
  windows(`native parser without Rust or gh: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-native-start-"));
    const scripts = path.join(root, "APP AI (fresh)", "scripts/dev");
    const crate = path.join(root, "APP AI (fresh)", "native/tokenatlas-parse");
    fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(crate, { recursive: true });
    const script = path.join(scripts, "build-native-parser.ps1"), wrapper = path.join(root, "trial.ps1");
    fs.copyFileSync(path.join(import.meta.dir, "build-native-parser.ps1"), script);
    const payload = "synthetic parser payload";
    fs.writeFileSync(path.join(crate, "release.json"), JSON.stringify({ source_hash: "fixture-source", tag: "fixture-release",
      repo: "KNODEdev/tokenAtlas", asset: "parser.exe", sha256: createHash("sha256").update(payload).digest("hex") }));
    fs.writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = 'original-prompt'
$env:GCM_INTERACTIVE = 'original-interactive'
function Get-Command {
    param($Name)
    if ($Name -eq 'cargo' -or $Name -eq 'gh') { return $null }
    if ($Name -eq 'git') { return @{Name='git'} }
    Microsoft.PowerShell.Core\\Get-Command $Name
}
function bun {
    param($Script, $What)
    switch ($What) { hash {'fixture-source'} rustflags {'portable'} asset {'parser.exe'} }
    $global:LASTEXITCODE = 0
}
function git {
    $request = $input | Out-String
    if ($request -notmatch 'host=github.com' -or $request -notmatch 'path=KNODEdev/tokenAtlas.git') { throw 'wrong Git credential scope' }
    if ($env:GIT_TERMINAL_PROMPT -ne '0' -or $env:GCM_INTERACTIVE -ne 'Never') { throw 'interactive credential lookup' }
    if (${literal(scenario)} -eq 'no login') { $global:LASTEXITCODE = 1; return }
    if (${literal(scenario)} -eq 'token login' -and $request -notmatch 'username=x-access-token') { $global:LASTEXITCODE = 1; return }
    'username=synthetic-user'
    'password=synthetic-secret'
    $global:LASTEXITCODE = 0
}
function Invoke-RestMethod {
    param($Headers, $Uri)
    if ($Headers.Authorization -ne 'Bearer synthetic-secret' -or $Uri -ne 'https://api.github.com/repos/KNODEdev/tokenAtlas/releases/tags/fixture-release') {
        throw 'incorrect authenticated release request'
    }
    return @{assets=@(@{name='parser.exe';id=123})}
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Headers, $Uri, $OutFile)
    if ($Uri -like 'https://github.com/*') {
        if (${literal(scenario)} -ne 'public') { throw 'private release requires login' }
    } elseif ($Headers.Authorization -ne 'Bearer synthetic-secret' -or $Headers.Accept -ne 'application/octet-stream' -or
        $Uri -ne 'https://api.github.com/repos/KNODEdev/tokenAtlas/releases/assets/123') { throw 'incorrect authenticated asset request' }
    $payload = if (${literal(scenario)} -eq 'bad checksum') {'corrupted parser'} else {${literal(payload)}}
    [IO.File]::WriteAllText($OutFile, $payload, (New-Object Text.UTF8Encoding $false))
}
& ${literal(script)}
$code = $LASTEXITCODE
if ($env:GIT_TERMINAL_PROMPT -ne 'original-prompt' -or $env:GCM_INTERACTIVE -ne 'original-interactive') { throw 'credential environment was not restored' }
exit $code
`);
    try {
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const success = scenario === "public" || scenario === "git login" || scenario === "token login";
      expect({ code, err }).toEqual({ code: success ? 0 : 1, err: "" });
      expect(out).not.toContain("synthetic-secret");
      const exe = path.join(crate, "target/release/tokenatlas-parse.exe");
      expect(fs.existsSync(exe)).toBe(success);
      expect(fs.existsSync(`${exe}.version`)).toBe(success);
      if (success) {
        expect(fs.readFileSync(exe, "utf8")).toBe(payload);
        expect(fs.readFileSync(`${exe}.version`, "utf8").trim()).toBe("fixture-source");
      } else if (scenario === "bad checksum") {
        expect(out).toContain("does not match the SHA-256");
        expect(fs.existsSync(path.join(crate, "target/download/parser.exe"))).toBe(false);
      } else expect(out).toContain("sign in with HTTPS Git");
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
  });
}
