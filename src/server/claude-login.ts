import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClaudeCredentials } from "../providers/adapters/claude";
import { refreshableProfileHome } from "../providers/adapters/claude-token-refresh";
import type { VendorDiscovery } from "./vendor-discovery";
import type { ClaudeLoginReason, ClaudeLoginRefusalReason, ClaudeLoginView } from "../shared/claude-login";

/**
 * "Connect Claude": starts the official Claude Code sign-in (`claude auth login --claudeai`) for one local profile,
 * so a user who only has the Claude desktop app signs in once in the browser. The desktop app's own sign-in is never
 * read; its bundled Claude Code binary is only run. Tokens never leave the CLI: this module compares a hash of the
 * profile's access token to see that a sign-in landed, and returns or logs no token.
 */

export interface ClaudeBinary { path: string; source: "path" | "desktop"; version: string | null }
/** The two filesystem questions the resolution asks; tests answer them from a fake tree. */
export interface BinaryFs { isFile(file: string): boolean; readdir(dir: string): string[] }
const nodeBinaryFs: BinaryFs = {
  isFile: file => { try { return fs.statSync(file).isFile(); } catch { return false; } },
  readdir: dir => { try { return fs.readdirSync(dir); } catch { return []; } },
};

const VERSION = /^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;
/** Newest first: numeric parts compared as numbers, a pre-release after its release. */
export function compareVersionsDesc(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map(Number);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return Number(/[-+]/.test(a)) - Number(/[-+]/.test(b)) || b.localeCompare(a);
}

/** Where the Claude desktop app unpacks its Claude Code: `<root>/<version>/<hash>/claude(.exe)`. */
export function desktopClaudeCodeRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string | null {
  if (platform === "win32") return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "Claude", "claude-code");
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "Claude", "claude-code");
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"), "Claude", "claude-code");
}

/**
 * The Claude Code binary to sign in with: a native `claude` on PATH first, else the newest binary the desktop app
 * ships. On Windows only `claude.exe` counts on PATH: an npm `claude.cmd` shim needs a shell and can be broken or
 * shadow the desktop install (as `codexProbeCommand` handles for Codex), and the login runs without a shell.
 */
export function resolveClaudeBinary({ platform = process.platform, env = process.env, home = os.homedir(), files = nodeBinaryFs }: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; files?: BinaryFs;
} = {}): ClaudeBinary | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const name = platform === "win32" ? "claude.exe" : "claude";
  const searchPath = env.PATH ?? env.Path ?? "";
  for (const raw of searchPath.split(platform === "win32" ? ";" : ":")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const candidate = p.join(dir, name);
    if (files.isFile(candidate)) return { path: candidate, source: "path", version: null };
  }
  const root = desktopClaudeCodeRoot(platform, env, home);
  if (!root) return null;
  const found: Array<{ path: string; version: string; hash: string; verified: boolean }> = [];
  for (const version of files.readdir(root).filter(entry => VERSION.test(entry))) {
    for (const hash of files.readdir(p.join(root, version))) {
      const binary = p.join(root, version, hash, name);
      if (!files.isFile(binary)) continue;
      // The app writes `.verified` once an unpacked binary checks out; a half-written one lacks it.
      found.push({ path: binary, version, hash, verified: files.isFile(p.join(root, version, hash, ".verified")) });
    }
  }
  found.sort((a, b) => Number(b.verified) - Number(a.verified) || compareVersionsDesc(a.version, b.version) || a.hash.localeCompare(b.hash));
  const best = found[0];
  return best ? { path: best.path, source: "desktop", version: best.version } : null;
}

const SIGN_IN_HOSTS = /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/i;
/** The first sign-in page the CLI printed (only Anthropic's own https hosts). */
export function signInUrl(text: string): string | null {
  for (const match of text.matchAll(/https:\/\/[^\s"'<>`]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === "https:" && SIGN_IN_HOSTS.test(url.hostname)) return url.toString();
    } catch { /* not a URL */ }
  }
  return null;
}
/** One output line for a reason shown on screen or logged: no URLs (they carry the sign-in state), no key-like text. */
export function safeOutputLine(line: string): string {
  return line.replace(/https?:\/\/\S+/g, "<url>").replace(/sk-ant-[\w-]+/g, "<redacted>").replace(/[A-Za-z0-9_-]{40,}/g, "<redacted>")
    .replace(/\s+/g, " ").trim().slice(0, 200);
}

export type ClaudeLoginRefusal = { status: 404 | 409; reason: ClaudeLoginRefusalReason; error: string };

type Launch = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ClaudeLoginOptions {
  resolveBinary?: () => ClaudeBinary | null;
  launch?: Launch;
  killTree?: (child: ChildProcess) => void;
  /** The whole sign-in, browser included; then the CLI and its children are killed. */
  timeoutMs?: number;
  /** How often the profile is checked for a new token while the CLI runs. */
  pollMs?: number;
  /** The profile Claude Code uses without CLAUDE_CONFIG_DIR. */
  defaultHome?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** A new token landed in the profile: read the limits now. */
  onSignedIn?: (subject: string, home: string) => void;
  log?: (message: string) => void;
}
export interface ClaudeLoginService {
  start(subject: string, home: string): { view: ClaudeLoginView } | ClaudeLoginRefusal;
  list(): ClaudeLoginView[];
  dispose(): void;
}

function defaultKillTree(child: ChildProcess): void {
  if (child.pid == null) return;
  try {
    // The CLI may have started helpers; the whole tree goes.
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}
/** A hash of the profile's access token, to see that a sign-in replaced it; the token itself is not kept. */
function tokenStamp(home: string): string | null {
  const token = readClaudeCredentials(home).creds?.token;
  return token ? createHash("sha256").update(token).digest("hex") : null;
}

export function createClaudeLoginService(options: ClaudeLoginOptions = {}): ClaudeLoginService {
  const platform = options.platform ?? process.platform;
  const fold = (home: string) => { const resolved = path.resolve(home); return platform === "win32" ? resolved.toLowerCase() : resolved; };
  const defaultHome = fold(options.defaultHome ?? path.join(os.homedir(), ".claude"));
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 2_000;
  const launch: Launch = options.launch ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const killTree = options.killTree ?? defaultKillTree;
  const log = options.log ?? (message => console.warn(`[tokenAtlas claude-login] ${message}`));
  const logins = new Map<string, { view: ClaudeLoginView; child: ChildProcess | null }>();

  function start(subject: string, home: string): { view: ClaudeLoginView } | ClaudeLoginRefusal {
    const key = fold(home);
    if (logins.get(key)?.child) return { status: 409, reason: "running", error: "A sign-in for this profile is already running." };
    const binary = (options.resolveBinary ?? resolveClaudeBinary)();
    if (!binary) return { status: 409, reason: "binary-missing",
      error: "No Claude Code binary was found (neither `claude` on PATH nor one bundled with the Claude desktop app)." };
    const before = tokenStamp(home);
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
    for (const name of Object.keys(env)) if (name.toUpperCase() === "CLAUDE_CONFIG_DIR") delete env[name];
    // The default profile keeps `.claude.json` beside the directory; naming it would move that file inside.
    if (key !== defaultHome) env.CLAUDE_CONFIG_DIR = home;
    const view: ClaudeLoginView = { subject, profile: home, state: "running", url: null, browser_opened: false, reason: null,
      exit_code: null, detail: null, started_at: new Date().toISOString(), finished_at: null };
    const entry: { view: ClaudeLoginView; child: ChildProcess | null } = { view, child: null };
    logins.set(key, entry);
    let output = "";
    let lastLine: string | null = null;
    let timedOut = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (state: "succeeded" | "failed", reason: ClaudeLoginReason | null, exitCode: number | null = null) => {
      if (view.state !== "running") return;
      view.state = state; view.reason = reason; view.exit_code = exitCode; view.finished_at = new Date().toISOString();
      if (state === "failed") {
        view.detail = lastLine;
        log(`sign-in for ${subject} failed (${reason}${exitCode != null ? `, exit ${exitCode}` : ""})${lastLine ? `: ${lastLine}` : ""}`);
      } else {
        try { options.onSignedIn?.(subject, home); } catch (error) { log(`limit reading after sign-in failed to start: ${String(error)}`); }
      }
    };
    const signedIn = () => { const now = tokenStamp(home); return now != null && now !== before; };
    let child: ChildProcess;
    try {
      child = launch(binary.path, ["auth", "login", "--claudeai"], { env, stdio: ["ignore", "pipe", "pipe"], shell: false,
        windowsHide: true, detached: platform !== "win32" });
    } catch (error) {
      lastLine = safeOutputLine((error as Error).message ?? String(error));
      finish("failed", "spawn");
      return { view: { ...view } };
    }
    entry.child = child;
    const read = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-8192);
      const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (lines.length) lastLine = safeOutputLine(lines[lines.length - 1]!);
      view.url ??= signInUrl(output);
      // Without a TTY the CLI says it opens the browser and prints the page for when it did not.
      view.browser_opened = /opening browser/i.test(output) && !/(fail|unable|could ?n[o']t)[^\n]{0,30}open/i.test(output);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    const stopTimers = () => { if (poll) clearInterval(poll); if (timer) clearTimeout(timer); poll = timer = null; };
    child.on("error", error => {
      stopTimers(); entry.child = null;
      lastLine = safeOutputLine(error.message);
      finish("failed", "spawn");
    });
    child.on("exit", code => {
      stopTimers(); entry.child = null;
      if (signedIn() || (code === 0 && tokenStamp(home) != null)) finish("succeeded", null, code);
      else finish("failed", timedOut ? "timeout" : code === 0 ? "no-credentials" : "exit", code);
    });
    // A token in the profile is the sign-in itself; the CLI may still be finishing its own writes.
    poll = setInterval(() => { if (signedIn()) finish("succeeded", null); }, pollMs);
    timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    return { view: { ...view } };
  }

  return {
    start,
    list: () => [...logins.values()].map(entry => ({ ...entry.view })),
    dispose() {
      for (const entry of logins.values()) {
        if (!entry.child) continue;
        const child = entry.child;
        entry.child = null;
        if (entry.view.state === "running") { entry.view.state = "failed"; entry.view.reason = "stopped"; entry.view.finished_at = new Date().toISOString(); }
        killTree(child);
      }
    },
  };
}

/**
 * The profile a Claude subscription is read from on this machine, exactly as the probe picks it
 * (`probeDiscoveredVendor`): the account's discovered profile here, an error-free one first. Only a profile the
 * probe may also write (`refreshableProfileHome`) can be signed in to.
 */
export function claudeLoginHome(subject: string, discovery: VendorDiscovery | undefined, machine: string,
  refreshable: (home: string) => string | null = home => refreshableProfileHome(home)): { home: string } | ClaudeLoginRefusal {
  if (!discovery) return { status: 409, reason: "no-discovery", error: "Claude profiles on this computer have not been discovered." };
  const id = subject.toLowerCase();
  const account = discovery.accounts.find(a => a.vendor === "claude" && a.id.toLowerCase() === id);
  if (!account) return { status: 404, reason: "unknown-subject", error: "Unknown Claude subscription." };
  const source = discovery.profiles.filter(p => p.vendor === "claude" && p.key === account.key && p.machine === machine && !p.worker)
    .sort((a, b) => Number(!!a.error) - Number(!!b.error))[0];
  if (!source || refreshable(source.home) == null)
    return { status: 409, reason: "not-local", error: "This subscription has no Claude Code profile of this user on this computer." };
  return { home: source.home };
}

export function loopbackOrigin(origin: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname); } catch { return false; }
}
/**
 * `GET /api/claude-login`:this computer's name and every profile's sign-in state. `POST { subject }` starts one
 * (202), refused with 404/409 and a reason. Only a same-origin JSON request may start a process.
 */
export async function handleClaudeLogin(req: Request, deps: { service: ClaudeLoginService; machine: string;
  resolveHome: (subject: string) => { home: string } | ClaudeLoginRefusal }): Promise<Response> {
  if (req.method === "GET") return Response.json({ machine: deps.machine, logins: deps.service.list() });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return Response.json({ error: "Body must be JSON" }, { status: 415 });
  // The app's own page (also through the Vite proxy on another port) is on this computer; a web page is not.
  const origin = req.headers.get("origin");
  if (origin && !loopbackOrigin(origin)) return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
  let subject: unknown;
  try { subject = ((await req.json()) as { subject?: unknown }).subject; } catch { return Response.json({ error: "Body must be JSON" }, { status: 400 }); }
  if (typeof subject !== "string" || !subject.trim() || subject.length > 200)
    return Response.json({ error: "`subject` must be a Claude subscription id" }, { status: 400 });
  const target = deps.resolveHome(subject.trim());
  if ("status" in target) return Response.json({ error: target.error, reason: target.reason }, { status: target.status });
  const started = deps.service.start(subject.trim(), target.home);
  if ("status" in started) return Response.json({ error: started.error, reason: started.reason }, { status: started.status });
  return Response.json({ login: started.view }, { status: 202 });
}
