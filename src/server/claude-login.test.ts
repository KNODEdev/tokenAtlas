import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeLoginHome, compareVersionsDesc, createClaudeLoginService, handleClaudeLogin, resolveClaudeBinary, safeOutputLine,
  signInUrl, type BinaryFs, type ClaudeLoginService } from "./claude-login";
import type { VendorDiscovery } from "./vendor-discovery";
import type { VendorProfile } from "../providers/vendor-identity";
import { readVendorProfile } from "../providers/vendor-identity";
import { readClaudeCredentials } from "../providers/adapters/claude";
import { claudeLoginMissing, probeErrorCode } from "../shared/probe-error";

const dirs: string[] = [];
const services: ClaudeLoginService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix = "atlas-claude-login-") => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };

/** A fake tree: listed files exist, directories are their prefixes. */
function fakeFs(files: string[]): BinaryFs {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const set = new Set(files.map(norm));
  return {
    isFile: file => set.has(norm(file)),
    readdir: dir => {
      const prefix = `${norm(dir).replace(/\/$/, "")}/`;
      const original = files.filter(file => norm(file).startsWith(prefix)).map(file => file.replace(/\\/g, "/").slice(prefix.length).split("/")[0]!);
      return [...new Set(original)];
    },
  };
}

const APPDATA = "C:\\Users\\u\\AppData\\Roaming";
const desktop = (version: string, hash: string, verified = true) => [
  `${APPDATA}\\Claude\\claude-code\\${version}\\${hash}\\claude.exe`,
  ...(verified ? [`${APPDATA}\\Claude\\claude-code\\${version}\\${hash}\\.verified`] : []),
];

test("a native claude on PATH wins; an npm shim does not, and the newest verified desktop binary is used instead", () => {
  const env = { PATH: "C:\\npm;C:\\Users\\u\\.local\\bin", APPDATA };
  const tree = [...desktop("2.1.293", "83cb"), ...desktop("2.1.295", "d2e2")];
  expect(resolveClaudeBinary({ platform: "win32", env, home: "C:\\Users\\u", files: fakeFs(["C:\\Users\\u\\.local\\bin\\claude.exe", ...tree]) }))
    .toEqual({ path: "C:\\Users\\u\\.local\\bin\\claude.exe", source: "path", version: null });
  // Only `claude.cmd` (an npm shim needing a shell) on PATH.
  expect(resolveClaudeBinary({ platform: "win32", env, home: "C:\\Users\\u", files: fakeFs(["C:\\npm\\claude.cmd", ...tree]) }))
    .toEqual({ path: `${APPDATA}\\Claude\\claude-code\\2.1.295\\d2e2\\claude.exe`, source: "desktop", version: "2.1.295" });
  // Versions compare as numbers; a half-unpacked (unverified) newer binary yields to a verified one.
  const sorted = fakeFs([...desktop("2.1.9", "a"), ...desktop("2.1.10", "b"), ...desktop("2.2.0", "c", false), `${APPDATA}\\Claude\\claude-code\\notes\\x\\claude.exe`]);
  expect(resolveClaudeBinary({ platform: "win32", env: { APPDATA }, home: "C:\\Users\\u", files: sorted })?.path)
    .toBe(`${APPDATA}\\Claude\\claude-code\\2.1.10\\b\\claude.exe`);
  expect(resolveClaudeBinary({ platform: "win32", env: { APPDATA }, home: "C:\\Users\\u", files: fakeFs(desktop("2.2.0", "c", false)) })?.version).toBe("2.2.0");
  expect(resolveClaudeBinary({ platform: "win32", env: { PATH: "C:\\npm", APPDATA }, home: "C:\\Users\\u", files: fakeFs(["C:\\npm\\claude.cmd"]) })).toBeNull();
  // Without APPDATA the roaming folder under the home is used.
  expect(resolveClaudeBinary({ platform: "win32", env: {}, home: "C:\\Users\\u", files: fakeFs(desktop("2.1.1", "h")) })?.source).toBe("desktop");
});

test("macOS: PATH first, then the app's Application Support folder", () => {
  const app = "/Users/u/Library/Application Support/Claude/claude-code";
  const files = fakeFs([`${app}/2.1.295/abc/claude`, `${app}/2.1.295/abc/.verified`, "/opt/homebrew/bin/claude"]);
  expect(resolveClaudeBinary({ platform: "darwin", env: { PATH: "/usr/bin:/opt/homebrew/bin" }, home: "/Users/u", files })?.path).toBe("/opt/homebrew/bin/claude");
  expect(resolveClaudeBinary({ platform: "darwin", env: { PATH: "/usr/bin" }, home: "/Users/u", files })?.path).toBe(`${app}/2.1.295/abc/claude`);
});

test("versions sort newest first, a pre-release after its release", () => {
  expect(["2.1.9", "2.1.10", "2.0.99", "2.1.10-beta"].sort(compareVersionsDesc)).toEqual(["2.1.10", "2.1.10-beta", "2.1.9", "2.0.99"]);
});

test("only Anthropic's own https pages are offered, and output lines lose URLs and key-like text", () => {
  const out = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\n";
  expect(signInUrl(out)).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");
  expect(signInUrl("visit http://claude.com/x or https://evil.example/claude.com")).toBeNull();
  expect(safeOutputLine("token sk-ant-oat01-abcdef at https://claude.com/x?code=1")).toBe("token <redacted> at <url>");
});

const profile = (over: Partial<VendorProfile>): VendorProfile => ({ vendor: "claude", home: "/h/.claude", login: "u", machine: "PC", key: "claude:a:o",
  email: "a@example.com", plan: null, error: null, surface: "claude-code", ...over });
function discovery(profiles: VendorProfile[]): VendorDiscovery {
  return { profiles, accounts: [{ id: "claude-a", vendor: "claude", key: "claude:a:o", email: "a@example.com", plan: null, current: true, profiles }] };
}

test("the profile is the one the probe reads on this computer, and only a refreshable one", () => {
  const local = profile({ home: "/h/.claude" });
  const ok = (home: string) => home;
  expect(claudeLoginHome("CLAUDE-A", discovery([local]), "PC", ok)).toEqual({ home: "/h/.claude" });
  expect(claudeLoginHome("claude-b", discovery([local]), "PC", ok)).toMatchObject({ status: 404, reason: "unknown-subject" });
  expect(claudeLoginHome("claude-a", discovery([profile({ machine: "OTHER" })]), "PC", ok)).toMatchObject({ status: 409, reason: "not-local" });
  expect(claudeLoginHome("claude-a", discovery([local]), "PC", () => null)).toMatchObject({ status: 409, reason: "not-local" });
  expect(claudeLoginHome("claude-a", undefined, "PC", ok)).toMatchObject({ status: 409, reason: "no-discovery" });
  // An error-free profile first, as the probe picks it.
  const two = discovery([profile({ home: "/h/broken", error: "x" }), profile({ home: "/h/good" })]);
  expect(claudeLoginHome("claude-a", two, "PC", ok)).toEqual({ home: "/h/good" });
});

const request = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("http://127.0.0.1:7331/api/claude-login", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("the route validates the request before any process starts", async () => {
  const started: string[] = [];
  const service: ClaudeLoginService = { start: (subject, home) => { started.push(`${subject}@${home}`); return { view: {} as never }; }, list: () => [], dispose: () => {} };
  const deps = { service, machine: "PC", resolveHome: (subject: string) => claudeLoginHome(subject, discovery([profile({})]), "PC", h => h) };
  const get = await handleClaudeLogin(new Request("http://127.0.0.1:7331/api/claude-login"), deps);
  expect(await get.json()).toEqual({ machine: "PC", logins: [] });
  expect((await handleClaudeLogin(request({ subject: "claude-a" }, { "content-type": "text/plain" }), deps)).status).toBe(415);
  expect((await handleClaudeLogin(request({ subject: "claude-a" }, { "content-type": "application/json", origin: "https://evil.example" }), deps)).status).toBe(403);
  expect((await handleClaudeLogin(request({ subject: 7 }), deps)).status).toBe(400);
  expect((await handleClaudeLogin(request("{"), deps)).status).toBe(400);
  const unknown = await handleClaudeLogin(request({ subject: "claude-z" }), deps);
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ reason: "unknown-subject" });
  const remote = await handleClaudeLogin(request({ subject: "claude-a" }), { ...deps,
    resolveHome: (subject: string) => claudeLoginHome(subject, discovery([profile({ machine: "OTHER" })]), "PC", h => h) });
  expect(remote.status).toBe(409);
  expect(started).toEqual([]);
  const accepted = await handleClaudeLogin(request({ subject: "claude-a" }, { "content-type": "application/json", origin: "http://localhost:7332" }), deps);
  expect(accepted.status).toBe(202);
  expect(started).toEqual(["claude-a@/h/.claude"]);
});

// A stand-in for `claude auth login`: prints what the real CLI prints without a TTY, then behaves per FAKE_MODE.
const FAKE = `
const fs = require("node:fs"), path = require("node:path");
const dir = process.env.CLAUDE_CONFIG_DIR || process.env.FAKE_HOME;
console.log("args=" + process.argv.slice(2).join(" ") + " config=" + (process.env.CLAUDE_CONFIG_DIR || "unset"));
console.log("Opening browser to sign in…");
console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1");
const mode = process.env.FAKE_MODE;
if (mode === "ok") setTimeout(() => { fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-SECRETTOKEN", refreshToken: "r" } })); process.exit(0); }, 100);
else if (mode === "fail") setTimeout(() => { console.error("Login failed"); process.exit(1); }, 100);
else if (mode === "quiet-ok") setTimeout(() => process.exit(0), 100);
else setInterval(() => {}, 1000);
`;
function fakeService(mode: string, home: string, extra: Partial<Parameters<typeof createClaudeLoginService>[0]> = {}) {
  const script = path.join(tmp("atlas-fake-claude-"), "claude.js");
  fs.writeFileSync(script, FAKE);
  const signedIn: string[] = [];
  const outputs: string[] = [];
  const service = createClaudeLoginService({
    resolveBinary: () => ({ path: "claude", source: "path", version: null }),
    launch: (_command, args, options) => {
      const child = spawn(process.execPath, [script, ...args], options);
      child.stdout?.on("data", chunk => outputs.push(String(chunk)));
      return child;
    },
    env: { ...process.env, FAKE_MODE: mode, FAKE_HOME: home, CLAUDE_CONFIG_DIR: "/somewhere/else" },
    defaultHome: path.join(tmp(), ".claude"),
    pollMs: 50,
    onSignedIn: (subject, at) => signedIn.push(`${subject}@${at}`),
    log: () => {},
    ...extra,
  });
  services.push(service);
  return { service, signedIn, outputs };
}
async function settled(service: ClaudeLoginService, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [view] = service.list();
    if (view && view.state !== "running") return view;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("sign-in did not settle");
}

test("a sign-in that saves a token succeeds, reads the limits at once and never exposes the token", async () => {
  const home = tmp();
  const { service, signedIn, outputs } = fakeService("ok", home);
  const started = service.start("claude-a", home);
  expect("view" in started && started.view.state).toBe("running");
  // One sign-in per profile at a time.
  expect(service.start("claude-a", home)).toMatchObject({ status: 409, reason: "running" });
  const view = await settled(service);
  expect(view).toMatchObject({ state: "succeeded", reason: null, browser_opened: true, subject: "claude-a",
    url: "https://claude.com/cai/oauth/authorize?code=true&state=s1" });
  expect(signedIn).toEqual([`claude-a@${home}`]);
  expect(JSON.stringify(service.list())).not.toContain("SECRETTOKEN");
  // A profile other than the default one is named; the server's own CLAUDE_CONFIG_DIR never leaks through.
  expect(outputs.join("")).toContain(`args=auth login --claudeai config=${home}`);
  expect(readClaudeCredentials(home).creds).not.toBeNull();
});

test("the default profile is signed in without CLAUDE_CONFIG_DIR", async () => {
  const home = tmp();
  const { service, outputs } = fakeService("ok", home, { defaultHome: home });
  service.start("claude-a", home);
  expect((await settled(service)).state).toBe("succeeded");
  expect(outputs.join("")).toContain("config=unset");
});

test("a failed, silent or stuck sign-in fails with a short reason", async () => {
  const failed = fakeService("fail", tmp());
  failed.service.start("claude-a", tmp());
  expect(await settled(failed.service)).toMatchObject({ state: "failed", reason: "exit", exit_code: 1, detail: "Login failed" });
  expect(failed.signedIn).toEqual([]);
  const quiet = fakeService("quiet-ok", tmp());
  quiet.service.start("claude-a", tmp());
  expect(await settled(quiet.service)).toMatchObject({ state: "failed", reason: "no-credentials", exit_code: 0 });
  const stuck = fakeService("hang", tmp(), { timeoutMs: 400 });
  stuck.service.start("claude-a", tmp());
  expect(await settled(stuck.service)).toMatchObject({ state: "failed", reason: "timeout" });
  // The profile is free again.
  expect("view" in stuck.service.start("claude-a", tmp())).toBe(true);
});

test("no binary, no process", () => {
  const service = createClaudeLoginService({ resolveBinary: () => null, launch: () => { throw new Error("must not spawn"); } });
  expect(service.start("claude-a", tmp())).toMatchObject({ status: 409, reason: "binary-missing" });
  expect(service.list()).toEqual([]);
});

test("a profile never signed in to Claude Code says so with its own code", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@example.com", accountUuid: "a", organizationUuid: "o" } }));
  const expected = process.platform === "darwin" ? null : "login-missing";
  expect(probeErrorCode(readClaudeCredentials(path.join(root, ".claude")).error)).toBe(expected);
  expect(probeErrorCode(readVendorProfile("claude", path.join(root, ".claude"), "PC").error)).toBe(expected);
  // The Keychain keeps the macOS sign-in, so there a missing file is not a missing sign-in.
  expect(probeErrorCode(claudeLoginMissing("/x/.credentials.json", "darwin"))).toBeNull();
  for (const platform of ["win32", "linux"])
    expect(probeErrorCode(claudeLoginMissing("/x/.credentials.json", platform))).toBe("login-missing");
  expect(claudeLoginMissing("/x/.credentials.json")).toBe(claudeLoginMissing("/x/.credentials.json", process.platform));
  // An unreadable file is not a missing sign-in.
  fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), "{");
  expect(probeErrorCode(readVendorProfile("claude", path.join(root, ".claude"), "PC").error)).toBeNull();
});

test("the shared missing-sign-in diagnostic uses the runtime platform and tolerates no process global", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  try {
    Object.defineProperty(globalThis, "process", { configurable: true, writable: true, value: { platform: "darwin" } });
    expect(probeErrorCode(claudeLoginMissing("/x/.credentials.json"))).toBeNull();
    Object.defineProperty(globalThis, "process", { configurable: true, writable: true, value: undefined });
    expect(probeErrorCode(claudeLoginMissing("/x/.credentials.json"))).toBe("login-missing");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "process", descriptor);
    else Reflect.deleteProperty(globalThis, "process");
  }
});
