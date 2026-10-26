import { execFile } from "child_process";
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/*
 * Refreshes a Claude Code profile's OAuth access token the way the Claude Code CLI does, for profiles whose
 * owner works in the Claude desktop app: its Code tab authenticates through the app and never refreshes
 * `.credentials.json`, so the token there expires within hours while nobody runs `claude`.
 *
 * Every constant below was read from the installed CLI bundle, Claude Code 2.1.293
 * (`%APPDATA%\Claude\claude-code\2.1.293\83cb0bd7fed4\claude.exe`; byte offsets of these exact strings):
 * - @209060961 `TOKEN_URL:"https://platform.claude.com/v1/oauth/token"` and
 *   @209061425 `CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"` (the production OAuth config `a={…}`);
 * - @212087329 `grant_type:"refresh_token",refresh_token:e,client_id:s??cn().CLIENT_ID,scope:R.join(" ")`,
 *   @212087464 `Et.post(cn().TOKEN_URL,P,{headers:{"Content-Type":"application/json"},timeout:30000`, and
 *   @212087693 `Y=Date.now()+q*1000` (`expiresAt` from `expires_in`; `refresh_token` defaults to the old one);
 * - scopes: @209060342 `r=[U5,RC,"user:sessions:claude_code","user:mcp_servers","user:file_upload"];function Slt()
 *   {…if(t.PLUGINS_SCOPE_REGISTERED)_.push(blt)…}` (U5 user:profile, RC user:inference, blt user:plugins); `xl()`
 *   asks for these plus stored `user:projects:*` scopes for a first-party login, otherwise the stored ones, and
 *   retries once with the stored ones on `invalid_scope`;
 * - due: @212091780 `function qP(e,n=Date.now()){if(e===null)return!1;return n+300000>=e}`;
 * - lock: @212053362 `function uLn(e,n){return{lockfilePath:Zf(e,".oauth_refresh.lock"),realpath:!1,stale:60000,
 *   update:5000`, @212053559 `` async function vA(e){return`${await vK(e).catch(()=>e)}.lock`} `` and
 *   @212053912 `S=await Aa(h,{...uLn(e,s),lockfilePath:h})` (the legacy lock, taken second), with
 *   @211378542 `realpath as vK` / `join as Zf` imported in the same chunk; `e` is the config dir
 *   (@212056945 `let z=cw();await se().mkdir(z);…q=await efs(z)`). `Aa` is proper-lockfile (@107236820
 *   "Lock file is already being held", @107236924 "Unable to update lock within the stale threshold");
 *   busy: @212057108 `if(n<5){…let _e=1000+Math.random()*1000` (5 retries after 1–2 s);
 * - save: @212039516 `if(!(U.claudeAiOauth!==void 0&&U.claudeAiOauth!==null&&(z===""||z===n)))return E=!0,U`
 *   (compare-and-swap on the posted refresh token; `sA()` keeps subscriptionType, rateLimitTier and the other
 *   keys); it saves even after its lock was compromised (@212039065 `if(h)i("tengu_oauth_token_refresh_lock_
 *   compromised_post_post",{})`); the file is @211131305 `.credentials.json` in `cw()`, written minified by the
 *   atomic writer @210835087 `` let w=`.tmp.${process.pid}.${q(6).toString("hex")}` ``.
 * The owner record `.oauth_refresh.lock.owner` (CLI dead-holder takeover) is optional and not written here: a
 * lock without it simply goes stale after 60 s, as proper-lockfile defines.
 *
 * No token value is ever logged, returned in an error or written anywhere but the credentials file.
 */
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** `Slt()` in production (PLUGINS_SCOPE_REGISTERED is true). */
export const CLAUDE_DEFAULT_SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers",
  "user:file_upload", "user:plugins"] as const;
const PROJECT_SCOPES = ["user:projects:read", "user:projects:write"];
export const CLAUDE_REFRESH_MARGIN_MS = 5 * 60_000;
export const CLAUDE_REFRESH_LOCK = ".oauth_refresh.lock";
const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 5_000;
const LOCK_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

export function claudeTokenDue(expiresAt: number | null | undefined, now = Date.now()): boolean {
  return typeof expiresAt === "number" && now + CLAUDE_REFRESH_MARGIN_MS >= expiresAt;
}

export type ClaudeRefreshFailure =
  /** The profile holds no refresh token (signed out, or the CLI blanked a dead one). */
  | "no-refresh-token"
  /** The token endpoint refused the refresh token, by its OAuth error name. */
  | { oauthError: string; status: number }
  /** The token endpoint failed or could not be reached. */
  | { status: number | null }
  /**
   * The new tokens could not be saved: refused before the refresh token was spent (`explicit-acl`, `acl-unknown`,
   * `not-writable`), or after it (`replace-failed`: the rotated pair is lost, the profile must sign in again).
   */
  | { save: SaveBlock | "replace-failed" };
export type ClaudeRefreshOutcome =
  | { status: "not-needed" }
  /** Refreshed by this call, or another process rotated the token meanwhile (`by: "other"`). */
  | { status: "refreshed"; by: "probe" | "other" }
  /** Another process holds the refresh lock (or took it over), and the token in the file is still the old one. */
  | { status: "busy" }
  | { status: "failed"; failure: ClaudeRefreshFailure };

export interface ClaudeRefreshOptions {
  /** The profile directory (`CLAUDE_CONFIG_DIR`): `.credentials.json` and the lock live there. */
  home: string;
  /** The access token the caller used; a different token in the file means someone refreshed already. */
  usedToken?: string;
  /** Refresh even if the token is not yet due (the server rejected it). */
  force?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called right after this call replaced the file (still under the lock). */
  onRewritten?: () => void;
  /** Test seams: the ACL reader (`icacls`), the rename, the lock heartbeat and a hook run once the lock is held. */
  readAcl?: (file: string) => Promise<string | null>;
  rename?: (from: string, to: string) => void;
  lockHeartbeatMs?: number;
  afterLock?: () => Promise<void> | void;
}

type OAuth = Record<string, unknown> & { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; scopes?: unknown;
  subscriptionType?: unknown; clientId?: unknown; refreshTokenExpiresAt?: unknown };
interface Stored { raw: Record<string, unknown>; oauth: OAuth }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Refresh tokens the endpoint refused (by hash): not posted again until the file holds another one.
const deadRefreshTokens = new Set<string>();
/** Forgets refused refresh tokens (tests). */
export function resetClaudeRefreshState(): void { deadRefreshTokens.clear(); }

function readStored(file: string): Stored | null {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const oauth = (raw as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return null;
  return { raw: raw as Record<string, unknown>, oauth: oauth as OAuth };
}
const text = (value: unknown) => typeof value === "string" && value ? value : null;
const expiry = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value > 1e12 ? value : value * 1000 : null;

/** What `xl()` asks for: the default scopes for a first-party login, otherwise exactly the stored ones. */
function requestedScopes(oauth: OAuth): { scopes: string[]; fallback: string[] | null } {
  const stored = Array.isArray(oauth.scopes) ? oauth.scopes.filter((s): s is string => typeof s === "string") : [];
  const firstParty = (stored.includes("user:inference") || !!oauth.subscriptionType) && !text(oauth.clientId);
  if (!firstParty) return { scopes: stored, fallback: null };
  const expanded = [...new Set([...CLAUDE_DEFAULT_SCOPES, ...stored.filter(s => PROJECT_SCOPES.includes(s))])];
  return { scopes: expanded, fallback: stored.includes("user:inference") ? stored : null };
}

/** Where a refresh may write: the real path of `home` when it lies on this machine, under one of `roots`. */
export function refreshableProfileHome(home: string, roots: readonly string[] = defaultRefreshRoots(),
  platform: NodeJS.Platform = process.platform): string | null {
  const unc = (value: string) => value.startsWith("\\\\") || value.startsWith("//");
  if (unc(home)) return null;
  let real: string;
  try { real = fs.realpathSync.native(home); } catch { return null; }
  // A junction or symlink can lead to another machine's share; its target decides.
  if (unc(real)) return null;
  const fold = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  for (const root of roots) {
    let base: string;
    try { base = fs.realpathSync.native(root); } catch { continue; }
    if (unc(base)) continue;
    const relative = path.relative(fold(base), fold(real));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return real;
  }
  return null;
}
/**
 * Node cannot tell a mapped network drive from a local disk (`statfs` reports no type on Windows), so a refresh is
 * allowed only inside the signed-in user's own home directory, which is local unless it is itself a share (then
 * its real path is a UNC path and refused). Other Windows users' profiles on this machine are not refreshed; they
 * get the sign-in notice instead. Under `bun test` only the temporary directory qualifies, so no test can ever
 * reach a real profile.
 */
function defaultRefreshRoots(): string[] {
  return process.env.NODE_ENV === "test" ? [os.tmpdir()] : [os.homedir()];
}

/** One ACE as icacls prints it: `NT AUTHORITY\SYSTEM:(I)(F)`, `EXAMPLE\x:(OI)(CI)(RX)`, `Everyone:(DENY)(W)`. */
const ACE = /^\S(?:.*\S)?:((?:\([A-Za-z,]+\))+)$/;
/**
 * The closing count line, in any language: two counts around a semicolon and nothing an ACE has (Polish:
 * "Pomyślnie przetworzono 1 plików; Nie można przetworzyć 0 plików", printed in the OEM code page).
 */
const SUMMARY = /^[^:()]*\d+[^:()]*;[^:()]*\d+[^:()]*$/;
/**
 * The Windows ACL of `file` as `icacls file` prints it: "inherited" when every entry carries `(I)`, "explicit"
 * when one does not (someone restricted this file by hand). Only known lines are accepted: the path line (with
 * the first entry), entry lines, blank lines and the count line; anything else, or no entry at all, is "unknown",
 * so an output this parser does not understand refuses the refresh instead of passing it.
 */
export function aclOrigin(icaclsOutput: string, file: string): "inherited" | "explicit" | "unknown" {
  let entries = 0;
  let explicit = false;
  let sawPath = false;
  for (const raw of icaclsOutput.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (!sawPath) {
      if (!line.toLowerCase().startsWith(file.toLowerCase())) return "unknown";
      sawPath = true;
      line = line.slice(file.length).trim();
      if (!line) continue;
    } else if (SUMMARY.test(line)) continue;
    const flags = line.match(ACE)?.[1];
    if (!flags) return "unknown";
    entries++;
    if (!flags.includes("(I)")) explicit = true;
  }
  return !entries ? "unknown" : explicit ? "explicit" : "inherited";
}
export type SaveBlock = "explicit-acl" | "acl-unknown" | "not-writable";
/**
 * Whether the replacement can keep the file's protection. The temp file is created in the same directory, so on
 * Windows it inherits that directory's ACL, which is what a file the CLI wrote has (its writer, like this one, only
 * chmods). A file with explicit entries would lose them on rename, so it is not refreshed; POSIX keeps the mode
 * through chmod. Checked before the refresh token is spent; the directory must also accept a new file.
 */
async function saveBlocked(file: string, readAcl: (file: string) => Promise<string | null>): Promise<SaveBlock | null> {
  const probe = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try { fs.closeSync(fs.openSync(probe, "wx", 0o600)); } catch { return "not-writable"; }
  finally { try { fs.unlinkSync(probe); } catch { /* never created */ } }
  if (process.platform !== "win32") return null;
  const output = await readAcl(file);
  const origin = output == null ? "unknown" : aclOrigin(output, file);
  return origin === "inherited" ? null : origin === "explicit" ? "explicit-acl" : "acl-unknown";
}
const icacls = (file: string) => new Promise<string | null>(resolve =>
  execFile("icacls", [file], { timeout: 5_000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout))));

interface DirLock {
  /** True once the lock is no longer provably ours (removed, or its mtime was set by someone else). */
  compromised(): boolean;
  release(): void;
}
function removeDir(dir: string): void { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left to go stale */ } }
/** Sets the lock's mtime and returns it as stored, which is how ownership is recognised afterwards. */
function stamp(dir: string): number {
  const at = new Date();
  fs.utimesSync(dir, at, at);
  return fs.statSync(dir).mtimeMs;
}
/**
 * proper-lockfile's protocol: the lock is a directory whose mtime the holder renews every `update` ms; one
 * untouched for `stale` ms is abandoned and may be taken over. Like proper-lockfile, the holder remembers the
 * mtime it set and treats any other value (a successor took the lock over) as compromised: it stops renewing,
 * and on release removes the directory only while it still carries its own mtime.
 */
function tryDirLock(dir: string, heartbeatMs = LOCK_UPDATE_MS): DirLock | "busy" {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let mtime: number;
      try { mtime = fs.statSync(dir).mtimeMs; } catch { continue; }
      if (mtime >= Date.now() - LOCK_STALE_MS) return "busy";
      removeDir(dir);
      continue;
    }
    let lost = false;
    let mine = NaN;
    try { mine = stamp(dir); } catch { lost = true; }
    const owned = () => {
      if (lost) return false;
      try { if (fs.statSync(dir).mtimeMs !== mine) lost = true; } catch { lost = true; }
      return !lost;
    };
    const timer = setInterval(() => {
      if (!owned()) { clearInterval(timer); return; }
      try { mine = stamp(dir); } catch { lost = true; clearInterval(timer); }
    }, heartbeatMs);
    timer.unref?.();
    return {
      compromised: () => !owned(),
      release: () => {
        clearInterval(timer);
        if (owned()) { try { fs.rmdirSync(dir); } catch { removeDir(dir); } }
        lost = true;
      },
    };
  }
  return "busy";
}
/** Both CLI locks, in the CLI's order; a legacy lock that cannot be created for another reason is skipped as the CLI does. */
function tryRefreshLock(home: string, heartbeatMs?: number): DirLock | "busy" {
  const primary = tryDirLock(path.join(home, CLAUDE_REFRESH_LOCK), heartbeatMs);
  if (primary === "busy") return "busy";
  let legacyPath: string;
  try { legacyPath = `${fs.realpathSync(home)}.lock`; } catch { legacyPath = `${home}.lock`; }
  let legacy: DirLock | "busy" | null = null;
  try { legacy = tryDirLock(legacyPath, heartbeatMs); } catch { legacy = null; }
  if (legacy === "busy") { primary.release(); return "busy"; }
  return {
    compromised: () => primary.compromised() || (legacy?.compromised() ?? false),
    release: () => { legacy?.release(); primary.release(); },
  };
}

// Waits between rename attempts (about 1 s in all): a reader holding the file open on Windows lets go quickly.
const RENAME_BACKOFF_MS = [100, 200, 300, 400];
/**
 * Atomic replace in the CLI's manner: a `.tmp.<pid>.<hex>` sibling with the file's mode, fsynced, renamed over.
 * Any failure removes the temp file. The original is never written in place, unlike the CLI's fallback: a
 * truncated original would lose every other key (`designOauth`, `mcpOAuth`) too. The cost of a refused rename
 * is the rotated token pair, already issued and now unsaved; the old refresh token is spent, so the profile
 * needs `claude` to sign in again, which the caller reports (`login-save-failed`).
 */
type Replace = "saved" | "failed" | "lost" | "changed";
/**
 * `prepare` runs before every rename attempt and answers the content to rename into place, built from the file
 * as it is at that moment, or why nothing may be renamed ("lost": the lock is no longer ours; "changed": someone
 * saved another refresh token). A retry waits, and whatever another writer saved meanwhile (`mcpOAuth`,
 * `designOauth`, any field) is kept: the temp file is rewritten whenever the content changed.
 */
async function replaceFile(file: string, sleep: (ms: number) => Promise<void>, rename: (from: string, to: string) => void,
  prepare: () => string | "lost" | "changed"): Promise<Replace> {
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* a new file keeps owner-only access */ }
  const temp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  let created = false;
  let written: string | null = null;
  let renamed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const content = prepare();
      if (content === "lost" || content === "changed") return content;
      if (content !== written) {
        // Created exclusively once; later rewrites only replace this call's own temp file.
        const fd = fs.openSync(temp, created ? "w" : "wx", mode);
        created = true;
        try {
          fs.writeFileSync(fd, content, { encoding: "utf8" });
          try { fs.fsyncSync(fd); } catch { /* not supported on every filesystem */ }
        } finally { fs.closeSync(fd); }
        try { fs.chmodSync(temp, mode); } catch { /* Windows keeps only the read-only bit */ }
        written = content;
      }
      try { rename(temp, file); renamed = true; return "saved"; } catch { /* retried below */ }
      if (attempt >= RENAME_BACKOFF_MS.length) return "failed";
      await sleep(RENAME_BACKOFF_MS[attempt]!);
    }
  } catch {
    return "failed";
  } finally {
    if (!renamed) { try { fs.unlinkSync(temp); } catch { /* never created */ } }
  }
}

interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; refresh_token_expires_in?: unknown; scope?: unknown; error?: unknown }
async function postRefresh(fetchImpl: typeof fetch, refreshToken: string, clientId: string, scopes: string[]):
  Promise<{ ok: true; body: TokenResponse } | { ok: false; status: number | null; oauthError: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, scope: scopes.join(" ") }),
      signal: controller.signal,
    });
    let body: TokenResponse | null = null;
    try { body = await response.json() as TokenResponse; } catch { body = null; }
    if (response.status === 200 && body) return { ok: true, body };
    // Only the OAuth error name is kept; `error_description` is vendor prose and could echo request data.
    const name = typeof body?.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;
    return { ok: false, status: response.status, oauthError: name };
  } catch {
    return { ok: false, status: null, oauthError: null };
  } finally { clearTimeout(timer); }
}

/**
 * Makes the profile's access token usable: nothing when it is not due, otherwise one refresh under the CLI's
 * lock. Under the lock the file is read again, so a token the CLI rotated meanwhile is adopted, never refreshed
 * twice. A refused refresh token leaves the file untouched. The refresh token is posted only while the lock is
 * provably held.
 */
export async function refreshClaudeCredentials(options: ClaudeRefreshOptions): Promise<ClaudeRefreshOutcome> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const file = path.join(options.home, ".credentials.json");
  const decide = (stored: Stored | null): ClaudeRefreshOutcome | null => {
    if (!stored) return { status: "failed", failure: "no-refresh-token" };
    const access = text(stored.oauth.accessToken);
    if (options.usedToken && access && access !== options.usedToken) return { status: "refreshed", by: "other" };
    if (!options.force && access && !claudeTokenDue(expiry(stored.oauth.expiresAt), now())) return { status: "not-needed" };
    const refresh = text(stored.oauth.refreshToken);
    if (!refresh) return { status: "failed", failure: "no-refresh-token" };
    if (deadRefreshTokens.has(hash(refresh))) return { status: "failed", failure: { oauthError: "invalid_grant", status: 400 } };
    return null;
  };
  const early = decide(readStored(file));
  if (early) return early;
  /** The CLI's bounded wait: 5 tries, 1–2 s apart; `meanwhile` may end the wait with an answer of its own. */
  const acquire = async (meanwhile: () => ClaudeRefreshOutcome | null): Promise<DirLock | "busy" | ClaudeRefreshOutcome> => {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const taken = tryRefreshLock(options.home, options.lockHeartbeatMs);
      if (taken !== "busy") return taken;
      await sleep(1000 + Math.random() * 1000);
      const answer = meanwhile();
      if (answer) return answer;
    }
    return "busy";
  };
  // The holder may have finished: its new token answers without a lock of our own.
  const first = await acquire(() => decide(readStored(file)));
  if (first === "busy") return { status: "busy" };
  if (!("release" in first)) return first;
  let lock: DirLock = first;
  try {
    await options.afterLock?.();
    const stored = readStored(file);
    const settled = decide(stored);
    if (settled) return settled;
    const blocked = await saveBlocked(file, options.readAcl ?? icacls);
    if (blocked) return { status: "failed", failure: { save: blocked } };
    const oauth = stored!.oauth;
    const posted = text(oauth.refreshToken)!;
    const clientId = text(oauth.clientId) ?? CLAUDE_OAUTH_CLIENT_ID;
    const { scopes, fallback } = requestedScopes(oauth);
    // A successor that took the lock over may be refreshing this very token; it must be spent only once.
    if (lock.compromised()) return { status: "busy" };
    let answer = await postRefresh(fetchImpl, posted, clientId, scopes);
    if (!answer.ok && answer.status === 400 && answer.oauthError === "invalid_scope" && fallback) {
      if (lock.compromised()) return { status: "busy" };
      answer = await postRefresh(fetchImpl, posted, clientId, fallback);
    }
    if (!answer.ok) {
      const refused = answer.status != null && answer.status >= 400 && answer.status < 500 && answer.status !== 429 && answer.status !== 408;
      if (refused && answer.oauthError === "invalid_grant") deadRefreshTokens.add(hash(posted));
      return { status: "failed", failure: refused && answer.oauthError ? { oauthError: answer.oauthError, status: answer.status! }
        : { status: answer.status } };
    }
    const body = answer.body;
    const access = text(body.access_token);
    if (!access || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in))
      return { status: "failed", failure: { status: 200 } };
    const issuedAt = now();
    const granted = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
    const rotated = text(body.refresh_token) ?? posted;
    const expiresAt = issuedAt + body.expires_in * 1000;
    const refreshExpiry = typeof body.refresh_token_expires_in === "number" ? { refreshTokenExpiresAt: issuedAt + body.refresh_token_expires_in * 1000 } : {};
    // Spent only when the server issued a different refresh token; a response that keeps the old one leaves it
    // usable, whatever happens to the save.
    const unsaved = (): ClaudeRefreshOutcome => {
      if (rotated !== posted) deadRefreshTokens.add(hash(posted));
      return { status: "failed", failure: { save: "replace-failed" } };
    };
    const storedRefresh = () => { const latest = readStored(file); return latest ? text(latest.oauth.refreshToken) : null; };
    // The save happens only under a provably held lock. One lost while the request ran is taken again (the same
    // bounded wait) instead of saving without it, as the CLI does (@212039065): a successor may save newer tokens
    // during a rename retry, and they win. Under the lock the file must still hold the token this call spent.
    for (let round = 0; round < 2; round++) {
      if (lock.compromised()) {
        lock.release();
        const again = await acquire(() => storedRefresh() !== posted ? { status: "refreshed", by: "other" } : null);
        if (again === "busy") return unsaved();
        if (!("release" in again)) return again;
        lock = again;
      }
      // Compare-and-swap as the CLI saves: only over the refresh token this call spent, and only this call's token
      // fields onto the file as it is right before each rename, every other key and field kept as found.
      const held = lock;
      const result = await replaceFile(file, sleep, options.rename ?? fs.renameSync, () => {
        if (held.compromised()) return "lost";
        const current = readStored(file);
        if (!current || text(current.oauth.refreshToken) !== posted) return "changed";
        const next: OAuth = {
          ...current.oauth,
          accessToken: access,
          refreshToken: rotated,
          expiresAt,
          ...refreshExpiry,
          ...(granted.length ? { scopes: granted } : {}),
        };
        return JSON.stringify({ ...current.raw, claudeAiOauth: next });
      });
      if (result === "saved") { options.onRewritten?.(); return { status: "refreshed", by: "probe" }; }
      if (result === "changed") return { status: "refreshed", by: "other" };
      if (result === "failed") return unsaved();
    }
    return unsaved();
  } finally {
    lock.release();
  }
}
