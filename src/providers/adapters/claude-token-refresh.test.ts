import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { aclOrigin, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_TOKEN_URL, CLAUDE_REFRESH_LOCK, refreshableProfileHome, refreshClaudeCredentials, resetClaudeRefreshState } from "./claude-token-refresh";
import { claudeProbeAdapter, readClaudeCredentials, resetClaudeIdentityCache } from "./claude";
import { probeErrorCode } from "../../shared/probe-error";

// Fake values only: no real profile is ever read or written by these tests.
const OLD_ACCESS = "sk-ant-oat01-OLD-ACCESS-fake";
const OLD_REFRESH = "sk-ant-ort01-OLD-REFRESH-fake";
const NEW_ACCESS = "sk-ant-oat01-NEW-ACCESS-fake";
const NEW_REFRESH = "sk-ant-ort01-NEW-REFRESH-fake";
const SECRETS = [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH];
const USAGE = "https://api.anthropic.com/api/oauth/usage";

let root: string;
let home: string;
const realFetch = globalThis.fetch;
const logged: string[] = [];
const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
const originals = Object.fromEntries(consoleMethods.map(m => [m, console[m]]));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-claude-refresh-"));
  home = path.join(root, ".claude");
  fs.mkdirSync(home);
  resetClaudeRefreshState();
  resetClaudeIdentityCache();
  logged.length = 0;
  for (const m of consoleMethods) console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const m of consoleMethods) console[m] = originals[m]!;
  fs.rmSync(root, { recursive: true, force: true });
  // No secret reached any log line.
  for (const line of logged) for (const secret of SECRETS) expect(line).not.toContain(secret);
});

/** A profile like the CLI writes it: minified, other keys around `claudeAiOauth`. */
function writeProfile(expiresAt: number, oauth: Record<string, unknown> = {}) {
  const raw = {
    mcpOAuth: { "server|1": { serverName: "s", accessToken: "mcp-fake" } },
    claudeAiOauth: { accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH, expiresAt, refreshTokenExpiresAt: 1_900_000_000_000,
      scopes: ["user:file_upload", "user:inference", "user:mcp_servers", "user:plugins", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "pro", rateLimitTier: "default_claude_ai", ...oauth },
    designOauth: { accessToken: "design-fake", refreshToken: "design-refresh-fake", expiresAt: 1, scopes: ["user:design:read"] },
  };
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify(raw));
  return raw;
}
const credentialsFile = () => path.join(home, ".credentials.json");
const readProfile = () => JSON.parse(fs.readFileSync(credentialsFile(), "utf8"));

interface Call { url: string; body: Record<string, unknown> | null }
function tokenEndpoint(answer: (call: Call) => Response, calls: Call[] = []) {
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = { url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    if (url !== CLAUDE_OAUTH_TOKEN_URL) throw new Error(`unexpected request to ${url}`);
    return answer(call);
  };
  return { calls, fetch: fake as unknown as typeof fetch };
}
const granted = (overrides: Record<string, unknown> = {}) => Response.json({ token_type: "Bearer", access_token: NEW_ACCESS,
  refresh_token: NEW_REFRESH, expires_in: 28_800, scope: "user:inference user:profile user:sessions:claude_code", ...overrides });
const noSleep = async () => {};

test("an expired token is refreshed once and the file is replaced atomically with every other key untouched", async () => {
  const before = writeProfile(Date.now() - 60_000);
  const ino = fs.statSync(credentialsFile()).ino;
  const endpoint = tokenEndpoint(() => granted());
  let rewritten = 0;
  const started = Date.now();
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, onRewritten: () => rewritten++ });
  expect(outcome).toEqual({ status: "refreshed", by: "probe" });
  expect(rewritten).toBe(1);
  expect(endpoint.calls).toHaveLength(1);
  // The request the CLI sends: JSON, its client id, the default first-party scopes.
  expect(endpoint.calls[0]!.body).toEqual({ grant_type: "refresh_token", refresh_token: OLD_REFRESH, client_id: CLAUDE_OAUTH_CLIENT_ID,
    scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins" });
  const after = readProfile();
  expect(Object.keys(after)).toEqual(Object.keys(before));
  expect(after.mcpOAuth).toEqual(before.mcpOAuth);
  expect(after.designOauth).toEqual(before.designOauth);
  expect(after.claudeAiOauth.accessToken).toBe(NEW_ACCESS);
  expect(after.claudeAiOauth.refreshToken).toBe(NEW_REFRESH);
  expect(after.claudeAiOauth.expiresAt).toBeGreaterThanOrEqual(started + 28_800_000);
  expect(after.claudeAiOauth.expiresAt).toBeLessThanOrEqual(Date.now() + 28_800_000);
  expect(after.claudeAiOauth.scopes).toEqual(["user:inference", "user:profile", "user:sessions:claude_code"]);
  expect([after.claudeAiOauth.subscriptionType, after.claudeAiOauth.rateLimitTier, after.claudeAiOauth.refreshTokenExpiresAt])
    .toEqual(["pro", "default_claude_ai", 1_900_000_000_000]);
  // Minified like the CLI writes it; replaced by a rename (a new file), no temp file or lock left behind.
  expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(JSON.stringify(after));
  if (ino) expect(fs.statSync(credentialsFile()).ino).not.toBe(ino);
  expect(fs.readdirSync(home).sort()).toEqual([".credentials.json"]);
  expect(fs.existsSync(`${home}.lock`)).toBe(false);
});

test("a token that is not due is not refreshed and the file is not touched", async () => {
  writeProfile(Date.now() + 60 * 60_000);
  const bytes = fs.readFileSync(credentialsFile(), "utf8");
  const endpoint = tokenEndpoint(() => granted());
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep })).toEqual({ status: "not-needed" });
  expect(endpoint.calls).toHaveLength(0);
  expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(bytes);
});

test("a token due within five minutes is refreshed", async () => {
  writeProfile(Date.now() + 4 * 60_000);
  const endpoint = tokenEndpoint(() => granted());
  expect((await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep })).status).toBe("refreshed");
  expect(endpoint.calls).toHaveLength(1);
});

test("a lock held by another writer is waited for, the file is read again and the token is not refreshed twice", async () => {
  writeProfile(Date.now() - 60_000);
  const lock = path.join(home, CLAUDE_REFRESH_LOCK);
  fs.mkdirSync(lock);
  const endpoint = tokenEndpoint(() => granted());
  let waits = 0;
  // The other writer (the CLI) finishes during the first wait: new tokens in the file, lock removed.
  const sleep = async () => {
    waits++;
    if (waits === 1) {
      const raw = readProfile();
      raw.claudeAiOauth = { ...raw.claudeAiOauth, accessToken: "cli-access-fake", refreshToken: "cli-refresh-fake", expiresAt: Date.now() + 8 * 3_600_000 };
      fs.writeFileSync(credentialsFile(), JSON.stringify(raw));
      fs.rmdirSync(lock);
    }
  };
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep })).toEqual({ status: "refreshed", by: "other" });
  expect(waits).toBe(1);
  expect(endpoint.calls).toHaveLength(0);
  expect(readProfile().claudeAiOauth.refreshToken).toBe("cli-refresh-fake");
});

test("a lock that stays busy gives up without a refresh; a stale one is taken over", async () => {
  writeProfile(Date.now() - 60_000);
  const lock = path.join(home, CLAUDE_REFRESH_LOCK);
  fs.mkdirSync(lock);
  const endpoint = tokenEndpoint(() => granted());
  let waits = 0;
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: async () => { waits++; } }))
    .toEqual({ status: "busy" });
  expect(waits).toBe(5);
  expect(endpoint.calls).toHaveLength(0);
  expect(fs.existsSync(lock)).toBe(true);
  // Untouched for over a minute: proper-lockfile's stale threshold, the holder is gone.
  const old = (Date.now() - 120_000) / 1000;
  fs.utimesSync(lock, old, old);
  expect((await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep })).status).toBe("refreshed");
  expect(endpoint.calls).toHaveLength(1);
  expect(fs.existsSync(lock)).toBe(false);
});

test("a busy legacy lock counts as busy and releases the new lock", async () => {
  writeProfile(Date.now() - 60_000);
  fs.mkdirSync(`${fs.realpathSync(home)}.lock`);
  const endpoint = tokenEndpoint(() => granted());
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep })).toEqual({ status: "busy" });
  expect(endpoint.calls).toHaveLength(0);
  expect(fs.existsSync(path.join(home, CLAUDE_REFRESH_LOCK))).toBe(false);
});

test("invalid_grant leaves the file unchanged and is not posted again", async () => {
  writeProfile(Date.now() - 60_000);
  const bytes = fs.readFileSync(credentialsFile(), "utf8");
  const mtime = fs.statSync(credentialsFile()).mtimeMs;
  const endpoint = tokenEndpoint(() => Response.json({ error: "invalid_grant", error_description: `Refresh token ${OLD_REFRESH} not found` }, { status: 400 }));
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep });
  expect(outcome).toEqual({ status: "failed", failure: { oauthError: "invalid_grant", status: 400 } });
  expect(JSON.stringify(outcome)).not.toContain(OLD_REFRESH);
  expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(bytes);
  expect(fs.statSync(credentialsFile()).mtimeMs).toBe(mtime);
  expect(fs.readdirSync(home)).toEqual([".credentials.json"]);
  await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep });
  expect(endpoint.calls).toHaveLength(1);
});

test("a refresh token rotated by someone else while the request ran is not overwritten", async () => {
  writeProfile(Date.now() - 60_000);
  const endpoint = tokenEndpoint(() => {
    // Another writer that ignores the lock saved its own pair meanwhile.
    const raw = readProfile();
    raw.claudeAiOauth = { ...raw.claudeAiOauth, accessToken: "sibling-access-fake", refreshToken: "sibling-refresh-fake" };
    fs.writeFileSync(credentialsFile(), JSON.stringify(raw));
    return granted();
  });
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep })).toEqual({ status: "refreshed", by: "other" });
  expect(readProfile().claudeAiOauth.refreshToken).toBe("sibling-refresh-fake");
});

test("a profile without a refresh token cannot be refreshed", async () => {
  writeProfile(Date.now() - 60_000, { refreshToken: "" });
  const endpoint = tokenEndpoint(() => granted());
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep }))
    .toEqual({ status: "failed", failure: "no-refresh-token" });
  expect(endpoint.calls).toHaveLength(0);
});

/** The probe as the discovery poller runs it on this machine: an expired profile, the usage endpoint mocked. */
function probeWith(token: (call: Call) => Response, usage: (authorization: string) => { ok: boolean; status: number; body: unknown }) {
  const endpoint = tokenEndpoint(token);
  globalThis.fetch = endpoint.fetch;
  const authorizations: string[] = [];
  const fetchJson = async (url: string, init: RequestInit) => {
    expect(url).toBe(USAGE);
    const authorization = (init.headers as Record<string, string>).Authorization!;
    authorizations.push(authorization);
    return usage(authorization);
  };
  let rewritten = 0;
  const run = () => {
    const credentials = readClaudeCredentials(home).creds!;
    return claudeProbeAdapter.request({ subscription: "one", home, refreshable: true, onCredentialsRewritten: () => rewritten++ },
      { credentials, fetchJson: fetchJson as never });
  };
  return { endpoint, authorizations, run, rewritten: () => rewritten };
}
const usageBody = { five_hour: { utilization: 12, resets_at: "2026-10-09T15:00:00Z" } };

test("the probe refreshes an expired token before reading and reads with the new one", async () => {
  writeProfile(Date.now() - 60_000);
  const probe = probeWith(() => granted(), () => ({ ok: true, status: 200, body: usageBody }));
  expect((await probe.run()).usage).toEqual(usageBody);
  expect(probe.endpoint.calls).toHaveLength(1);
  expect(probe.authorizations).toEqual([`Bearer ${NEW_ACCESS}`]);
  expect(probe.rewritten()).toBe(1);
});

test("a token the server rejects before its expiry is refreshed once and the read retried once", async () => {
  writeProfile(Date.now() + 60 * 60_000);
  const probe = probeWith(() => granted(), authorization => authorization.endsWith(NEW_ACCESS)
    ? { ok: true, status: 200, body: usageBody } : { ok: false, status: 401, body: null });
  expect((await probe.run()).usage).toEqual(usageBody);
  expect(probe.endpoint.calls).toHaveLength(1);
  expect(probe.authorizations).toEqual([`Bearer ${OLD_ACCESS}`, `Bearer ${NEW_ACCESS}`]);
  // A second rejection after the refresh is final, not another refresh.
  resetClaudeRefreshState();
  writeProfile(Date.now() + 60 * 60_000);
  const always = probeWith(() => granted(), () => ({ ok: false, status: 401, body: null }));
  const error = await always.run().catch((e: Error) => e);
  expect(probeErrorCode((error as Error).message)).toBe("login-expired");
  expect(always.endpoint.calls).toHaveLength(1);
  expect(always.authorizations).toHaveLength(2);
});

test("invalid_grant becomes a coded login-expired error without any token value and without a file change", async () => {
  writeProfile(Date.now() - 60_000);
  const bytes = fs.readFileSync(credentialsFile(), "utf8");
  const probe = probeWith(() => Response.json({ error: "invalid_grant", error_description: `bad ${OLD_REFRESH}` }, { status: 400 }),
    () => { throw new Error("usage must not be read with an expired token"); });
  const error = await probe.run().catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(probeErrorCode(message)).toBe("login-expired");
  expect(message).toBe("[login-expired] Claude sign-in expired: the token refresh was refused (invalid_grant, HTTP 400); run `claude` and sign in (/login).");
  for (const secret of SECRETS) expect(message).not.toContain(secret);
  expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(bytes);
  expect(probe.rewritten()).toBe(0);
});

test("an unreachable or failing token endpoint is named by status only", async () => {
  writeProfile(Date.now() - 60_000);
  const failing = probeWith(() => new Response(`oops ${OLD_REFRESH}`, { status: 503 }), () => ({ ok: true, status: 200, body: usageBody }));
  const error = await failing.run().catch((e: Error) => e);
  expect((error as Error).message).toBe("[login-expired] Claude sign-in expired: the token endpoint failed (HTTP 503); run `claude` and sign in (/login).");
  const offline = probeWith(() => { throw new TypeError(`connect failed ${OLD_REFRESH}`); }, () => ({ ok: true, status: 200, body: usageBody }));
  const unreachable = await offline.run().catch((e: Error) => e);
  expect((unreachable as Error).message).toContain("the token endpoint could not be reached");
  for (const secret of SECRETS) expect((unreachable as Error).message).not.toContain(secret);
});

test("a profile that is not this machine's, or a network path, is never refreshed", async () => {
  writeProfile(Date.now() - 60_000);
  const bytes = fs.readFileSync(credentialsFile(), "utf8");
  const endpoint = tokenEndpoint(() => granted());
  globalThis.fetch = endpoint.fetch;
  const fetchJson = async () => ({ ok: false, status: 401, body: null });
  const credentials = readClaudeCredentials(home).creds!;
  for (const target of [{ subscription: "one", home }, { subscription: "one", home: `\\\\other-pc\\c$\\Users\\x\\.claude`, refreshable: true }]) {
    const error = await claudeProbeAdapter.request(target, { credentials, fetchJson: fetchJson as never }).catch((e: Error) => e);
    expect(probeErrorCode((error as Error).message)).toBe("login-expired");
  }
  expect(endpoint.calls).toHaveLength(0);
  expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(bytes);
});

test("a profile the CLI signed out (blank tokens) reads as an expired sign-in", () => {
  writeProfile(0, { accessToken: "", refreshToken: "" });
  const result = readClaudeCredentials(home);
  expect(result.creds).toBeNull();
  expect(probeErrorCode(result.error)).toBe("login-expired");
});

// --- review fixes: temp-file cleanup, no in-place write, lock ownership, local paths, ACLs ---

const ACL_FILE = "C:\\Users\\x\\.claude\\.credentials.json";
const aclFor = (file: string) => [
  `${file} NT AUTHORITY\\SYSTEM:(I)(F)`,
  "                                     BUILTIN\\Administrators:(I)(F)",
  "                                     EXAMPLE\\x:(I)(F)",
  "",
  "Successfully processed 1 files; Failed processing 0 files",
].join("\r\n");
const INHERITED_ACL = aclFor(ACL_FILE);
const inheritedAcl = async (file: string) => aclFor(file);
const leftovers = () => fs.readdirSync(home).filter(name => name !== ".credentials.json");

test("a failed write of the temp file removes it and leaves the original as it was", async () => {
  writeProfile(Date.now() - 60_000);
  const bytes = fs.readFileSync(credentialsFile(), "utf8");
  const endpoint = tokenEndpoint(() => granted());
  const write = spyOn(fs, "writeFileSync").mockImplementation(((target: unknown) => {
    if (typeof target === "number") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    throw new Error("the original must never be written in place");
  }) as never);
  try {
    const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, readAcl: inheritedAcl });
    expect(outcome).toEqual({ status: "failed", failure: { save: "replace-failed" } });
  } finally { write.mockRestore(); }
  expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(bytes);
  expect(leftovers()).toEqual([]);
});

test("a refused rename is retried for about a second, never truncates the original and is a coded save failure", async () => {
  writeProfile(Date.now() - 60_000);
  const bytes = fs.readFileSync(credentialsFile(), "utf8");
  const endpoint = tokenEndpoint(() => granted());
  let renames = 0;
  const waits: number[] = [];
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, readAcl: inheritedAcl,
    sleep: async ms => { waits.push(ms); },
    rename: () => { renames++; throw Object.assign(new Error("in use"), { code: "EPERM" }); } });
  expect(outcome).toEqual({ status: "failed", failure: { save: "replace-failed" } });
  expect(renames).toBe(5);
  expect(waits).toEqual([100, 200, 300, 400]);
  expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(bytes);
  expect(leftovers()).toEqual([]);
  // The spent refresh token is not posted again.
  await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, readAcl: inheritedAcl });
  expect(endpoint.calls).toHaveLength(1);
});

test("the probe reports a save failure as login-save-failed, without any token value", async () => {
  writeProfile(Date.now() - 60_000);
  const rename = spyOn(fs, "renameSync").mockImplementation((() => { throw Object.assign(new Error("in use"), { code: "EPERM" }); }) as never);
  try {
    const probe = probeWith(() => granted(), () => { throw new Error("usage must not be read"); });
    const error = await probe.run().catch((e: Error) => e);
    const message = (error as Error).message;
    expect(probeErrorCode(message)).toBe("login-save-failed");
    expect(message).toContain("run `claude`");
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  } finally { rename.mockRestore(); }
  expect(leftovers()).toEqual([]);
});

test("a lock taken over by a successor is compromised: no refresh is posted and the successor's lock survives", async () => {
  writeProfile(Date.now() - 60_000);
  const lock = path.join(home, CLAUDE_REFRESH_LOCK);
  const endpoint = tokenEndpoint(() => granted());
  let successor = 0;
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, readAcl: inheritedAcl,
    lockHeartbeatMs: 10,
    afterLock: async () => {
      // As if this process stalled past the stale threshold and the CLI took the lock over.
      fs.rmSync(lock, { recursive: true });
      fs.mkdirSync(lock);
      const at = new Date(Date.now() - 1_000);
      fs.utimesSync(lock, at, at);
      successor = fs.statSync(lock).mtimeMs;
      await new Promise(resolve => setTimeout(resolve, 60));
      // The heartbeat saw a foreign mtime and stopped renewing.
      expect(fs.statSync(lock).mtimeMs).toBe(successor);
    } });
  expect(outcome).toEqual({ status: "busy" });
  expect(endpoint.calls).toHaveLength(0);
  expect(fs.existsSync(lock)).toBe(true);
  expect(fs.statSync(lock).mtimeMs).toBe(successor);
  // Its own legacy lock is released normally.
  expect(fs.existsSync(`${fs.realpathSync(home)}.lock`)).toBe(false);
});

test("a held lock keeps its own mtime fresh and is released", async () => {
  writeProfile(Date.now() - 60_000);
  const lock = path.join(home, CLAUDE_REFRESH_LOCK);
  const endpoint = tokenEndpoint(() => granted());
  const stamps: number[] = [];
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, readAcl: inheritedAcl,
    lockHeartbeatMs: 10,
    afterLock: async () => {
      stamps.push(fs.statSync(lock).mtimeMs);
      await new Promise(resolve => setTimeout(resolve, 60));
      stamps.push(fs.statSync(lock).mtimeMs);
    } });
  expect(outcome).toEqual({ status: "refreshed", by: "probe" });
  expect(stamps[1]).toBeGreaterThan(stamps[0]!);
  expect(fs.existsSync(lock)).toBe(false);
});

test("only a profile on this machine's disk, inside an allowed root, may be refreshed", () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ta-claude-elsewhere-"));
  try {
    expect(refreshableProfileHome(home, [root])).toBe(fs.realpathSync.native(home));
    expect(refreshableProfileHome(home, [other])).toBeNull();
    // UNC paths, as given or as a share mounted under a drive letter resolves to, are another machine's disk.
    expect(refreshableProfileHome("\\\\other-pc\\c$\\Users\\x\\.claude", [root])).toBeNull();
    expect(refreshableProfileHome("//other-pc/share/.claude", [root])).toBeNull();
    expect(refreshableProfileHome(path.join(root, "missing"), [root])).toBeNull();
    if (process.platform === "win32") expect(refreshableProfileHome(home.toUpperCase(), [root.toLowerCase()])).not.toBeNull();
    // Under `bun test` the default root is the temporary directory only: no real profile qualifies.
    expect(process.env.NODE_ENV).toBe("test");
    expect(refreshableProfileHome(home)).not.toBeNull();
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test("icacls output tells an inherited ACL from an explicit one", () => {
  expect(aclOrigin(INHERITED_ACL, ACL_FILE)).toBe("inherited");
  // Polish Windows prints its summary in Polish; the entries keep their syntax.
  const x = "C:\\x\\.credentials.json";
  expect(aclOrigin(`${x} EXAMPLE\\x:(I)(F)\r\n\r\nPomyślnie przetworzono 1 plików; Nie można przetworzyć 0 plików`, x)).toBe("inherited");
  // The same summary as the OEM code page arrives when decoded as UTF-8.
  expect(aclOrigin(`${x} EXAMPLE\\x:(I)(F)\r\nPomy\uFFFDlnie przetworzono 1 plik\uFFFDw; Nie mo\uFFFDna przetworzy\uFFFD 0 plik\uFFFDw`, x)).toBe("inherited");
  expect(aclOrigin(`${x} EXAMPLE\\x:(F)\r\n  NT AUTHORITY\\SYSTEM:(I)(F)\r\n`, x)).toBe("explicit");
  expect(aclOrigin(`${x} Everyone:(DENY)(W)\r\n`, x)).toBe("explicit");
  expect(aclOrigin(`${x} EXAMPLE\\x:(OI)(CI)(I)(RX,W)\r\n`, x)).toBe("inherited");
  expect(aclOrigin("Access is denied.", x)).toBe("unknown");
  expect(aclOrigin("", x)).toBe("unknown");
  // Fails closed: one inherited entry does not vouch for lines the parser does not understand.
  expect(aclOrigin(`${x} EXAMPLE\\x:(I)(F)\r\n  something unexpected\r\n`, x)).toBe("unknown");
  expect(aclOrigin(`${x} EXAMPLE\\x:(I)(F)\r\n  OWNER RIGHTS:(I)(F) [conditional]\r\n`, x)).toBe("unknown");
  expect(aclOrigin(`C:\\other\\file EXAMPLE\\x:(I)(F)\r\n`, x)).toBe("unknown");
});

test("on Windows a file with explicit permissions, or unreadable ones, is not refreshed and the token is not spent", async () => {
  if (process.platform !== "win32") return;
  for (const [acl, save] of [[(file: string) => `${file} EXAMPLE\\x:(F)`, "explicit-acl"],
    [(file: string) => `${file} EXAMPLE\\x:(I)(F)\r\n?? unparsed ??`, "acl-unknown"], [() => null, "acl-unknown"]] as const) {
    resetClaudeRefreshState();
    writeProfile(Date.now() - 60_000);
    const bytes = fs.readFileSync(credentialsFile(), "utf8");
    const endpoint = tokenEndpoint(() => granted());
    expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, readAcl: async file => acl(file) }))
      .toEqual({ status: "failed", failure: { save } });
    expect(endpoint.calls).toHaveLength(0);
    expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(bytes);
    expect(leftovers()).toEqual([]);
  }
});

// --- re-review fixes: no overwrite of a successor, rotation-aware dead tokens ---

/** The CLI after a takeover: its own lock and its own newer pair in the file. */
function successorSaves(options: { takeLock: boolean }) {
  const lock = path.join(home, CLAUDE_REFRESH_LOCK);
  if (options.takeLock) {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
    const at = new Date(Date.now() - 1_000);
    fs.utimesSync(lock, at, at);
  }
  const raw = readProfile();
  raw.claudeAiOauth = { ...raw.claudeAiOauth, accessToken: "successor-access-fake", refreshToken: "successor-refresh-fake",
    expiresAt: Date.now() + 8 * 3_600_000 };
  fs.writeFileSync(credentialsFile(), JSON.stringify(raw));
  return lock;
}

test("a successor that takes the lock and saves during a rename retry is not overwritten", async () => {
  writeProfile(Date.now() - 60_000);
  const endpoint = tokenEndpoint(() => granted());
  let renames = 0;
  let successorLock: string | null = null;
  let successorStamp = 0;
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, readAcl: inheritedAcl,
    rename: (from, to) => { renames++; if (renames === 1) throw Object.assign(new Error("in use"), { code: "EPERM" }); fs.renameSync(from, to); },
    sleep: async () => {
      if (successorLock) return;
      successorLock = successorSaves({ takeLock: true });
      successorStamp = fs.statSync(successorLock).mtimeMs;
    } });
  expect(outcome).toEqual({ status: "refreshed", by: "other" });
  expect(renames).toBe(1);
  expect(endpoint.calls).toHaveLength(1);
  expect(readProfile().claudeAiOauth.refreshToken).toBe("successor-refresh-fake");
  expect(readProfile().claudeAiOauth.accessToken).toBe("successor-access-fake");
  // The successor's lock is its own still; no temp file is left.
  expect(fs.statSync(successorLock!).mtimeMs).toBe(successorStamp);
  expect(leftovers()).toEqual([CLAUDE_REFRESH_LOCK]);
});

test("a writer that saves during a rename retry without the lock is not overwritten either", async () => {
  writeProfile(Date.now() - 60_000);
  const endpoint = tokenEndpoint(() => granted());
  let renames = 0;
  let saved = false;
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, readAcl: inheritedAcl,
    rename: (from, to) => { renames++; if (renames === 1) throw Object.assign(new Error("in use"), { code: "EPERM" }); fs.renameSync(from, to); },
    sleep: async () => { if (!saved) { saved = true; successorSaves({ takeLock: false }); } } });
  expect(outcome).toEqual({ status: "refreshed", by: "other" });
  expect(renames).toBe(1);
  expect(readProfile().claudeAiOauth.refreshToken).toBe("successor-refresh-fake");
  expect(leftovers()).toEqual([]);
});

test("a lock lost while the request ran is taken again before saving", async () => {
  writeProfile(Date.now() - 60_000);
  const lock = path.join(home, CLAUDE_REFRESH_LOCK);
  // The stalled holder's lock was taken over and then released by its successor, which saved nothing.
  const endpoint = tokenEndpoint(() => { fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock); fs.rmdirSync(lock); return granted(); });
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, readAcl: inheritedAcl });
  expect(outcome).toEqual({ status: "refreshed", by: "probe" });
  expect(readProfile().claudeAiOauth.refreshToken).toBe(NEW_REFRESH);
  expect(fs.existsSync(lock)).toBe(false);
});

test("a response that keeps the refresh token leaves it usable, saved or not", async () => {
  writeProfile(Date.now() - 60_000);
  const endpoint = tokenEndpoint(() => granted({ refresh_token: undefined }));
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, sleep: noSleep, readAcl: inheritedAcl }))
    .toEqual({ status: "refreshed", by: "probe" });
  expect(readProfile().claudeAiOauth.refreshToken).toBe(OLD_REFRESH);
  // The next refresh posts it again instead of inventing invalid_grant.
  expect((await refreshClaudeCredentials({ home, usedToken: NEW_ACCESS, force: true, fetch: endpoint.fetch, sleep: noSleep, readAcl: inheritedAcl })).status)
    .toBe("refreshed");
  expect(endpoint.calls).toHaveLength(2);
  // The same token echoed back, and a save that fails: still not dead.
  resetClaudeRefreshState();
  writeProfile(Date.now() - 60_000);
  const echo = tokenEndpoint(() => granted({ refresh_token: OLD_REFRESH }));
  const refused = () => { throw Object.assign(new Error("in use"), { code: "EPERM" }); };
  expect(await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: echo.fetch, sleep: noSleep, readAcl: inheritedAcl, rename: refused }))
    .toEqual({ status: "failed", failure: { save: "replace-failed" } });
  expect((await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: echo.fetch, sleep: noSleep, readAcl: inheritedAcl })).status)
    .toBe("refreshed");
  expect(echo.calls).toHaveLength(2);
});

test("another writer's change to other keys during a rename retry survives, and the new tokens are saved", async () => {
  writeProfile(Date.now() - 60_000);
  const endpoint = tokenEndpoint(() => granted());
  let renames = 0;
  let changed = false;
  const outcome = await refreshClaudeCredentials({ home, usedToken: OLD_ACCESS, fetch: endpoint.fetch, readAcl: inheritedAcl,
    rename: (from, to) => { renames++; if (renames === 1) throw Object.assign(new Error("in use"), { code: "EPERM" }); fs.renameSync(from, to); },
    sleep: async () => {
      if (changed) return;
      changed = true;
      // The CLI saves an MCP sign-in and its plan tier meanwhile, leaving Claude's refresh token as it was.
      const raw = readProfile();
      raw.mcpOAuth = { ...raw.mcpOAuth, "new-server|2": { serverName: "n", accessToken: "mcp-new-fake" } };
      raw.claudeAiOauth = { ...raw.claudeAiOauth, rateLimitTier: "default_claude_max_5x" };
      fs.writeFileSync(credentialsFile(), JSON.stringify(raw));
    } });
  expect(outcome).toEqual({ status: "refreshed", by: "probe" });
  expect(renames).toBe(2);
  const after = readProfile();
  expect(after.mcpOAuth["new-server|2"]).toEqual({ serverName: "n", accessToken: "mcp-new-fake" });
  expect(after.mcpOAuth["server|1"]).toEqual({ serverName: "s", accessToken: "mcp-fake" });
  expect(after.claudeAiOauth.rateLimitTier).toBe("default_claude_max_5x");
  expect([after.claudeAiOauth.accessToken, after.claudeAiOauth.refreshToken]).toEqual([NEW_ACCESS, NEW_REFRESH]);
  expect(leftovers()).toEqual([]);
});
