import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { decodeJwtPayload } from "./core/identity";
import { profileDirectories } from "./profile-directories";

export interface CodexAccountIdentity {
  key: string;
  account_id: string | null;
  email: string | null;
}
export interface CodexProfile {
  home: string;
  login: string;
  machine: string;
  identity: CodexAccountIdentity | null;
  error: string | null;
}
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;

/** Return account metadata only. Credentials never leave this function. */
export function readCodexAccountIdentity(home: string): { identity: CodexAccountIdentity | null; error: string | null } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
    const claims = decodeJwtPayload(raw?.tokens?.id_token);
    const auth = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const account_id = text(raw?.tokens?.account_id) ?? text(auth?.chatgpt_account_id) ?? text(claims?.account_id);
    const email = text(claims?.email)?.toLowerCase() ?? null;
    if (!account_id && !email) return { identity: null, error: "No ChatGPT login in this Codex profile" };
    return { identity: { key: account_id ? `account:${account_id}` : `email:${email}`, account_id, email }, error: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { identity: null, error: code === "ENOENT" ? "No ChatGPT login in this Codex profile"
      : code === "EACCES" || code === "EPERM" ? "Windows denied access to this Codex profile"
      : "Cannot read the ChatGPT identity in this Codex profile" };
  }
}

export function scanCodexProfiles(options: {
  home?: string; machine?: string; platform?: string; codexHome?: string; declaredHomes?: string[];
} = {}): CodexProfile[] {
  const home = options.home ?? process.env.USERPROFILE ?? os.homedir();
  const machine = options.machine ?? process.env.TOKENATLAS_MACHINE ?? process.env.COMPUTERNAME ?? os.hostname();
  const platform = options.platform ?? process.platform;
  const candidates = new Map<string, { home: string; login: string; explicit: boolean }>();
  const add = (root: string, login: string, explicit = false) => {
    const resolved = path.resolve(root);
    const key = platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!candidates.has(key)) candidates.set(key, { home: resolved, login, explicit });
  };
  const login = path.basename(home);
  add(path.join(home, ".codex"), login, true);
  for (const directory of profileDirectories(home, ".codex")) add(directory, login);
  const custom = options.codexHome ?? process.env.CODEX_HOME;
  if (custom) add(custom, login, true);
  for (const root of options.declaredHomes ?? []) add(root, path.basename(path.dirname(root)), true);
  if (platform === "win32") {
    try {
      for (const entry of fs.readdirSync(path.dirname(home), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const root = path.join(path.dirname(home), entry.name);
          add(path.join(root, ".codex"), entry.name);
          for (const directory of profileDirectories(root, ".codex")) add(directory, entry.name);
        }
      }
    } catch { /* The current and declared profiles still remain inspectable. */ }
  }
  const profiles: CodexProfile[] = [];
  for (const candidate of candidates.values()) {
    try { fs.statSync(candidate.home); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !candidate.explicit) continue; }
    profiles.push({ home: candidate.home, login: candidate.login, machine, ...readCodexAccountIdentity(candidate.home) });
  }
  return profiles;
}

export const discoveredCodexId = (identity: CodexAccountIdentity): string =>
  `chatgpt-${createHash("sha256").update(identity.key).digest("hex").slice(0, 16)}`;

export interface CodexIdentityEvidence extends CodexAccountIdentity {
  subscription: string;
  login: string;
  machine: string;
  home: string;
}

export function codexIdentityEvidence(extra: string | null): CodexIdentityEvidence | null {
  try {
    const e = JSON.parse(JSON.parse(extra ?? "null")?.codex_account ?? "null");
    if (!e || !text(e.key) || !text(e.subscription) || !text(e.home) || !text(e.machine) || !text(e.login)) return null;
    if (e.key !== (text(e.account_id) ? `account:${e.account_id}` : `email:${text(e.email)?.toLowerCase()}`)) return null;
    if (!text(e.account_id) && !text(e.email)) return null;
    return { key: e.key, account_id: text(e.account_id), email: text(e.email), subscription: e.subscription,
      home: e.home, machine: e.machine, login: e.login };
  } catch { return null; }
}
