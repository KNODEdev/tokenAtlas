import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const launcher = fs.readFileSync(path.join(import.meta.dir, "../../_dev.bat"), "utf8");
const subroutine = launcher.slice(launcher.indexOf("\r\n:install_bun\r\n") + 2);
const windows = test.skipIf(process.platform !== "win32");
const writeBatch = (file: string, text: string) => fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"));

for (const scenario of ["custom", "default", "update failure", "install failure"] as const) {
  windows(`Bun launcher ${scenario} uses the selected installation and propagates failures`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bun-launcher-"));
    const profile = path.join(root, "user (with spaces)"), install = scenario === "default" ? path.join(profile, ".bun") : path.join(root, "bun (custom install)");
    const bin = path.join(install, "bin"), stubs = path.join(root, "stubs"), trace = path.join(root, "trace.txt"), harness = path.join(root, "harness.bat");
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(stubs);
    if (scenario !== "install failure") fs.writeFileSync(path.join(bin, "bun.exe"), "");
    writeBatch(path.join(bin, "bun.cmd"), `@echo off\necho selected %*>>"%ATLAS_BUN_TRACE%"\nexit /b ${scenario === "update failure" ? 7 : 0}\n`);
    writeBatch(path.join(stubs, "bun.cmd"), "@echo off\necho wrong-installation>>\"%ATLAS_BUN_TRACE%\"\nexit /b 9\n");
    writeBatch(path.join(stubs, "powershell.cmd"), `@echo off\necho selected-update %~7>>"%ATLAS_BUN_TRACE%"\nexit /b ${scenario.endsWith("failure") ? 5 : 0}\n`);
    writeBatch(harness, `@echo off\ncall :install_bun\nexit /b %errorlevel%\n${subroutine}`);
    // Windows environment names are case insensitive; do not retain a second inherited Path key.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    const env: NodeJS.ProcessEnv = { ...inherited, USERPROFILE: profile, PATH: `${stubs};${process.env.PATH}`, PATHEXT: ".CMD;.EXE;.BAT;.COM", ATLAS_BUN_TRACE: trace };
    if (scenario === "default") delete env.BUN_INSTALL;
    else env.BUN_INSTALL = install;
    try {
      const child = Bun.spawn([process.env.ComSpec ?? "cmd.exe", "/d", "/c", harness], { env, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, err }).toEqual({ code: scenario.endsWith("failure") ? 1 : 0, err: "" });
      const calls = fs.readFileSync(trace, "utf8").trim().split(/\r?\n/);
      expect(calls).toEqual([`selected-update ${bin}`]);
      expect(out).not.toContain("wrong-installation");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("Bun update runs before server retirement and data operations, and batch keeps CRLF", () => {
  expect(launcher).not.toMatch(/(?<!\r)\n/);
  const prepare = launcher.indexOf("call :install_bun");
  expect(prepare).toBeGreaterThan(0);
  for (const later of ["free-port.ps1", "call bun install", "call bun scripts\\dev\\prepare-app.ts", "call bun run serve"])
    expect(launcher.indexOf(later)).toBeGreaterThan(prepare);
  expect(launcher).toContain("call :install_bun || (pause & exit /b 1)");
});

test("the application bundle and browser are ready before database preparation starts", () => {
  const build = launcher.indexOf("call bun run build:web");
  const browser = launcher.indexOf('start "" /B cmd /c "scripts\\dev\\wait-and-open.bat');
  const preparation = launcher.indexOf("call bun scripts\\dev\\prepare-app.ts");
  const serving = launcher.indexOf("call bun run serve");
  expect(build).toBeGreaterThan(0);
  expect(browser).toBeGreaterThan(build);
  expect(preparation).toBeGreaterThan(browser);
  expect(serving).toBeGreaterThan(preparation);
  expect(launcher).not.toContain("call bun run db:migrate");
  expect(launcher).not.toContain("call bun run doctor");
});

for (const scenario of ["fresh", "cached", "lock changed", "package changed", "install failure", "account failure",
  "cached missing", "repair failure", "health failure", "partial install", "cached broken bin", "bin health failure"] as const) {
  windows(`startup ${scenario} prepares dependencies before account preflight and port retirement`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-run-"));
    const app = path.join(root, "APP AI (fresh install)"), stubs = path.join(root, "stubs");
    const trace = path.join(root, "trace.txt"), harness = path.join(app, "_dev.bat");
    fs.mkdirSync(app); fs.mkdirSync(stubs);
    const cached = ["cached", "lock changed", "package changed", "cached missing", "repair failure", "health failure",
      "cached broken bin", "bin health failure"].includes(scenario);
    if (cached) {
      fs.mkdirSync(path.join(app, "node_modules"));
      if (["cached", "lock changed", "package changed", "cached broken bin", "bin health failure"].includes(scenario))
        fs.writeFileSync(path.join(app, "node_modules", ".ready"), "");
      if (["cached", "lock changed", "package changed"].includes(scenario))
        fs.writeFileSync(path.join(app, "node_modules", ".bin-ready"), "");
      fs.mkdirSync(path.join(app, ".dev-cache"));
      fs.writeFileSync(path.join(app, ".dev-cache", "bun-install.stamp"), "cached");
    }
    writeBatch(path.join(stubs, "bun.cmd"), `@echo off
if "%~1"=="--version" (echo 1.4.3 & exit /b 0)
if "%~1"=="install" goto install
if "%~1"=="-e" goto check
if "%~1"=="run" goto bin_check
if "%~1"=="scripts\\dev\\repair-dependencies.ts" goto repair
echo accounts>>"%ATLAS_STARTUP_TRACE%"
if not exist "node_modules\\.ready" (echo Cannot find module drizzle-orm/bun-sqlite & exit /b 3)
if "%ATLAS_STARTUP_SCENARIO%"=="account failure" (echo accounts v2: invalid configuration & exit /b 3)
exit /b 0
:install
echo install %*>>"%ATLAS_STARTUP_TRACE%"
if "%ATLAS_STARTUP_SCENARIO%"=="install failure" exit /b 7
if "%ATLAS_STARTUP_SCENARIO%"=="repair failure" exit /b 7
if not exist node_modules mkdir node_modules
if "%ATLAS_STARTUP_SCENARIO%"=="health failure" exit /b 0
if "%ATLAS_STARTUP_SCENARIO%"=="partial install" exit /b 0
echo ready>node_modules\\.ready
echo ready>node_modules\\.bin-ready
exit /b 0
:repair
echo repair>>"%ATLAS_STARTUP_TRACE%"
if exist ".dev-cache\\bun-install.stamp" del /q ".dev-cache\\bun-install.stamp"
if "%ATLAS_STARTUP_SCENARIO%"=="repair failure" exit /b 7
if not exist node_modules mkdir node_modules
if "%ATLAS_STARTUP_SCENARIO%"=="health failure" exit /b 0
echo ready>node_modules\\.ready
if not "%ATLAS_STARTUP_SCENARIO%"=="bin health failure" echo ready>node_modules\\.bin-ready
exit /b 0
:check
echo check>>"%ATLAS_STARTUP_TRACE%"
if not exist "node_modules\\.ready" exit /b 3
exit /b 0
:bin_check
echo bin-check>>"%ATLAS_STARTUP_TRACE%"
if not "%~2 %~3"=="vite --version" exit /b 9
if not exist "node_modules\\.bin-ready" (echo error: could not find bin metadata file & exit /b 255)
exit /b 0
`);
    writeBatch(path.join(stubs, "powershell.cmd"), `@echo off
if "%~2"=="-Command" goto timestamp
echo free-port>>"%ATLAS_STARTUP_TRACE%"
exit /b 0
:timestamp
set "CHECK=%~3"
if "%ATLAS_STARTUP_SCENARIO%"=="lock changed" if not "%CHECK:bun.lock=%"=="%CHECK%" (echo 1& exit /b 0)
if "%ATLAS_STARTUP_SCENARIO%"=="package changed" if not "%CHECK:package.json=%"=="%CHECK%" (echo 1& exit /b 0)
echo 0
exit /b 0
`);
    writeBatch(path.join(stubs, "curl.cmd"), "@exit /b 0\n");
    // Execute the real launcher's bootstrap; stop before native builds and any data operations.
    const bootstrap = launcher.slice(0, launcher.indexOf("REM --- Native parser"))
      .replace("call :install_bun || (pause & exit /b 1)", "REM Bun installation is stubbed for this test.");
    const checkDependencies = launcher.slice(launcher.lastIndexOf("\r\n:check_dependencies\r\n") + 2);
    writeBatch(harness, `${bootstrap}\nexit /b 0\n${checkDependencies}`);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    try {
      const child = Bun.spawn([process.env.ComSpec ?? "cmd.exe", "/d", "/c", harness], {
        cwd: root, env: { ...inherited, PATH: `${stubs};${process.env.PATH}`, PATHEXT: ".CMD;.EXE;.BAT;.COM",
          ATLAS_STARTUP_TRACE: trace, ATLAS_STARTUP_SCENARIO: scenario }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, err }).toEqual({ code: scenario.endsWith("failure") ? 1 : 0, err: "" });
      const calls = fs.readFileSync(trace, "utf8").trim().split(/\r?\n/);
      const install = "install install --frozen-lockfile --backend=copyfile";
      const repair = "repair";
      const healthyCheck = ["check", "bin-check"];
      expect(calls).toEqual(scenario === "install failure" ? [install]
        : scenario === "account failure" ? [install, ...healthyCheck, "accounts"]
        : scenario === "cached" ? [...healthyCheck, "accounts", "free-port"]
        : scenario === "cached missing" ? ["check", repair, ...healthyCheck, "accounts", "free-port"]
        : scenario === "cached broken bin" ? [...healthyCheck, repair, ...healthyCheck, "accounts", "free-port"]
        : scenario === "bin health failure" ? [...healthyCheck, repair, ...healthyCheck]
        : scenario === "repair failure" ? ["check", repair]
        : scenario === "health failure" ? ["check", repair, "check"]
        : scenario === "partial install" ? [install, "check", repair, ...healthyCheck, "accounts", "free-port"]
        : [install, ...healthyCheck, "accounts", "free-port"]);
      expect(fs.existsSync(path.join(app, ".dev-cache", "bun-install.stamp")))
        .toBe(!["install failure", "repair failure", "health failure", "bin health failure"].includes(scenario));
      expect(out).not.toContain("Cannot find module");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

windows("a failed stable-release lookup preserves the existing Bun executable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bun-update-failure-"));
  const bin = path.join(root, "bin"), wrapper = path.join(root, "failure.ps1");
  fs.mkdirSync(bin);
  const target = path.join(bin, "bun.exe"), original = Buffer.from("existing executable remains intact");
  fs.writeFileSync(target, original);
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  fs.writeFileSync(wrapper, `function Invoke-RestMethod { throw 'synthetic offline lookup' }\n& ${literal(path.join(import.meta.dir, "update-bun.ps1"))} -BunBin ${literal(bin)}\nexit $LASTEXITCODE\n`);
  try {
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(err).toBe(""); expect(out).toContain("synthetic offline lookup");
    expect(fs.readFileSync(target)).toEqual(original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

windows("failed Bun publication restores the previous executable after staging beside the target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bun-update-rollback-"));
  const bin = path.join(root, "custom (install)"), wrapper = path.join(root, "rollback.ps1");
  fs.mkdirSync(bin);
  const target = path.join(bin, "bun.exe"), original = Buffer.from("unreadable previous executable retained for rollback");
  fs.writeFileSync(target, original);
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const installer = `param([string]$Version,[switch]$NoPathUpdate,[switch]$NoRegisterInstallation,[switch]$NoCompletions)\nNew-Item -ItemType Directory -Path (Join-Path $env:BUN_INSTALL 'bin') | Out-Null\nCopy-Item -LiteralPath ${literal(process.execPath)} -Destination (Join-Path $env:BUN_INSTALL 'bin/bun.exe')\n`;
  fs.writeFileSync(wrapper, `
function Invoke-RestMethod { param($Uri)
  if ($Uri -like '*api.github.com*') { return @{tag_name=${literal(`bun-v${Bun.version}`)};prerelease=$false} }
  return ${literal(installer)}
}
function Move-Item { param($LiteralPath,$Destination)
  if ([IO.Path]::GetFileName($LiteralPath) -like 'bun.pending-*') {
    if ([IO.Path]::GetDirectoryName($LiteralPath) -ne [IO.Path]::GetDirectoryName($Destination)) { throw 'not staged beside target' }
    [IO.File]::WriteAllText($Destination,'synthetic partial publication')
    throw 'synthetic publish failure'
  }
  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
& ${literal(path.join(import.meta.dir, "update-bun.ps1"))} -BunBin ${literal(bin)}
exit $LASTEXITCODE
`);
  try {
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(err).toBe(""); expect(out).toContain("synthetic publish failure");
    expect(fs.readFileSync(target)).toEqual(original);
    expect(fs.readdirSync(bin)).toEqual(["bun.exe"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
