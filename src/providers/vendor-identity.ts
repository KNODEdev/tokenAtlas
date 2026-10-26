import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadPool, type PoolAccount } from "./adapters/gemini";
import { profileDirectories } from "./profile-directories";
import { claudeLoginMissing } from "../shared/probe-error";
import { canonicalPeriodPlan } from "../shared/period-end";

export type DiscoveredVendor = "claude" | "grok" | "gemini";
export interface VendorProfile {
  vendor: DiscoveredVendor;
  home: string;
  login: string;
  machine: string;
  key: string | null;
  email: string | null;
  plan: string | null;
  error: string | null;
  surface: "claude-code" | "grok-cli" | "gemini-cli" | "antigravity";
  worker?: PoolAccount;
  authenticatedAt?: string;
  revision?: string;
  /** Claude: the account's rate-limit tier exactly as the profile states it, and when the CLI fetched it. */
  planTier?: string;
  planReadAt?: string;
}
/** The profile whose plan was read most recently; one machine's CLI may not have refreshed yet. */
export const newestPlanProfile = <T extends Pick<VendorProfile, "planReadAt">>(profiles: readonly T[]): T | undefined =>
  profiles.reduce<T | undefined>((best, p) => p.planReadAt && (!best?.planReadAt || p.planReadAt > best.planReadAt) ? p : best ?? p, undefined);
/** `default_claude_max_5x` -> `max-5x`, the spelling the plans catalog knows; other tiers have no multiplier to read. */
export const planOfTier = (tier: string | null): string | null => {
  const multiplier = tier?.match(/max_(\d+)x$/i)?.[1];
  return multiplier ? `max-${multiplier}x` : null;
};
const scalar = (x: unknown): string | null => typeof x === "string" && x.trim() ? x.trim() : null;
const emailOf = (x: unknown): string | null => typeof x === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) ? x.trim().toLowerCase() : null;
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Only allowlisted account metadata leaves the credential reader. */
export function readVendorProfile(vendor: DiscoveredVendor, home: string, machine: string, login = path.basename(path.dirname(home))): VendorProfile {
  const row: VendorProfile = { vendor, home, machine, login, key: null, email: null, plan: null, error: null,
    surface: vendor === "claude" ? "claude-code" : vendor === "grok" ? "grok-cli" : "gemini-cli" };
  try {
    if (vendor === "claude") {
      const localConfig = path.join(home, ".claude.json");
      const local = fs.existsSync(localConfig) ? json(localConfig) : null;
      // A settings-only file inside the default profile must not hide its sibling account file.
      // An explicit local sign-out still wins over an older sibling identity.
      const account = (local != null && Object.hasOwn(local, "oauthAccount") ? local
        : json(path.join(path.dirname(home), `${path.basename(home)}.json`))).oauthAccount;
      row.email = emailOf(account?.emailAddress);
      const id = scalar(account?.accountUuid);
      const org = scalar(account?.organizationUuid);
      row.key = id ? `claude:${id}:${org ?? "personal"}` : row.email ? `claude:email:${row.email}` : null;
      // The token keeps the plan it was issued under (`pro` for weeks after an upgrade to Max);
      // the profile the CLI refreshes is the current one.
      const tier = scalar(account?.organizationRateLimitTier);
      const fetched = typeof account?.profileFetchedAt === "number" ? new Date(account.profileFetchedAt) : null;
      if (tier && fetched && Number.isFinite(fetched.getTime())) { row.planTier = tier; row.planReadAt = fetched.toISOString(); }
      row.plan = planOfTier(tier) ?? (tier && canonicalPeriodPlan(tier) !== tier ? canonicalPeriodPlan(tier) : null);
      const credentialsFile = path.join(home, ".credentials.json");
      try {
        const credentials = json(credentialsFile).claudeAiOauth;
        // A stated tier is never replaced by the token's label: after Max ends the token still says `max`.
        if (!tier) row.plan = scalar(credentials?.subscriptionType);
      } catch {
        row.error = fs.existsSync(credentialsFile) ? "Claude credentials unavailable; sign in to Claude Code in this Windows profile."
          : claudeLoginMissing(credentialsFile);
      }
    } else if (vendor === "grok") {
      const entries = Object.values(json(path.join(home, "auth.json"))) as Array<Record<string, unknown>>;
      const accounts = entries.filter(x => x && typeof x === "object" && (scalar(x.user_id) || emailOf(x.email)));
      const keys = new Set(accounts.map(x => `${scalar(x.user_id) ?? emailOf(x.email)}:${scalar(x.team_id) ?? "personal"}`));
      if (keys.size !== 1) throw new Error("ambiguous identity");
      const account = accounts[0]!;
      row.email = emailOf(account.email);
      row.key = `grok:${[...keys][0]}`;
      const created = scalar(account.create_time);
      if (created && Number.isFinite(Date.parse(created))) row.authenticatedAt = new Date(created).toISOString();
    } else {
      row.email = emailOf(json(path.join(home, "google_accounts.json")).active);
      row.key = row.email ? `gemini-cli:${row.email}` : null;
      row.error = "Gemini CLI account detected; no quota reader is connected for this surface.";
    }
    if (!row.key) row.error = "No unambiguous signed-in account in this profile.";
  } catch (error) {
    row.key = null;
    row.error = ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ? "Windows denied access to this account profile." : "No readable, unambiguous account identity in this profile.";
  }
  row.revision = [home, ...(vendor === "claude" ? [path.join(home, ".claude.json"),path.join(path.dirname(home), `${path.basename(home)}.json`),path.join(home,".credentials.json")] : [path.join(home,vendor === "grok" ? "auth.json" : "google_accounts.json")])].map(file=>{try {const s=fs.statSync(file);return `${s.mtimeMs}:${s.size}`;}catch{return "unavailable";}}).join("|");
  return row;
}

/**
 * A Claude revision without the profile directory and `.credentials.json`: the parts a token refresh rewrites.
 * What remains (`.claude.json`) is where a sign-in to another account shows.
 */
export function claudeAccountRevision(revision: string | undefined): string | undefined {
  const parts = revision?.split("|");
  return parts && parts.length === 4 ? parts.slice(1, 3).join("|") : revision;
}

export function scanVendorProfiles(options: { home?: string; machine?: string; platform?: string; pool?: PoolAccount[];
  declaredHomes?: Array<{ vendor: DiscoveredVendor; home: string }>; vendor?: DiscoveredVendor } = {}): VendorProfile[] {
  const root = options.home ?? process.env.USERPROFILE ?? os.homedir();
  const machine = options.machine ?? process.env.COMPUTERNAME ?? os.hostname();
  const roots = new Set([root]);
  if ((options.platform ?? process.platform) === "win32") {
    try { for (const dir of fs.readdirSync(path.dirname(root), { withFileTypes: true })) if (dir.isDirectory()) roots.add(path.join(path.dirname(root), dir.name)); } catch {}
  }
  const rows: VendorProfile[] = [];
  const seen = new Set<string>();
  const add = (vendor: DiscoveredVendor, home: string, explicit = false) => {
    if (options.vendor && options.vendor !== vendor) return;
    const key = `${vendor}:${path.resolve(home).toLowerCase()}`;
    if (seen.has(key)) return;
    const file = vendor === "claude" ? path.join(path.dirname(home), `${path.basename(home)}.json`)
      : path.join(home, vendor === "grok" ? "auth.json" : "google_accounts.json");
    try { fs.statSync(vendor === "claude" && fs.existsSync(path.join(home, ".claude.json")) ? path.join(home, ".claude.json") : file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return; }
    seen.add(key);
    rows.push(readVendorProfile(vendor, home, machine));
  };
  for (const userRoot of roots) for (const vendor of ["claude", "grok", "gemini"] as const) add(vendor, path.join(userRoot, `.${vendor}`));
  for (const userRoot of roots) for (const vendor of options.vendor ? [options.vendor] : ["claude", "grok", "gemini"] as const)
    for (const directory of profileDirectories(userRoot, `.${vendor}`)) add(vendor, directory, true);
  for (const source of options.declaredHomes ?? []) add(source.vendor, source.home, true);
  for (const [vendor, custom] of [["claude", process.env.CLAUDE_CONFIG_DIR], ["grok", process.env.GROK_HOME]] as const) if (custom) add(vendor, custom, true);
  for (const worker of !options.vendor || options.vendor === "gemini" ? options.pool ?? loadPool() : []) {
    const email = emailOf(worker.google);
    rows.push({ vendor: "gemini", surface: "antigravity", machine, login: worker.profile, home: `pool:${worker.id}`,
      email, key: email ? `antigravity:${email}` : null, plan: null, worker,
      error: email ? "Configured Antigravity account; worker does not verify the active login, so quota is withheld to prevent mixing accounts." : "Antigravity pool entry has no Google account email." });
  }
  return rows;
}

export const discoveredVendorId = (profile: Pick<VendorProfile, "vendor" | "key">): string =>
  `${profile.vendor}-${createHash("sha256").update(profile.key!).digest("hex").slice(0, 16)}`;
