import type { Database } from "bun:sqlite";
import { claudeAccountRevision, discoveredVendorId, newestPlanProfile, readVendorProfile, scanVendorProfiles, type VendorProfile } from "../providers/vendor-identity";
import { MACHINE } from "../config/paths";
import { claudeProbeAdapter } from "../providers/adapters/claude";
import { grokProbeAdapter } from "../providers/adapters/grok";
import { geminiProbeAdapter } from "../providers/adapters/gemini";
import { persistProbeWindows, probeTarget } from "../providers/core/probe";
import type { WindowReading } from "../providers/types";
import { claudeIdentitySubscription } from "../ingest/claude-identity";

export interface VendorAccount {
  id: string; vendor: VendorProfile["vendor"]; key: string; email: string | null; plan: string | null;
  current: boolean; profiles: VendorProfile[];
}
export interface VendorDiscovery { profiles: VendorProfile[]; accounts: VendorAccount[] }

/**
 * A profile as identity: `revision` holds file times that a running client rewrites every few
 * seconds. Only a probe reads it, to confirm the profile it resolved is still unchanged.
 */
export function profileIdentity({ revision: _revision, ...profile }: VendorProfile): Omit<VendorProfile, "revision"> {
  return profile;
}
/** What views and change detection may depend on; a rewritten profile file is not an account change. */
export function vendorDiscoveryIdentity(discovery: VendorDiscovery | undefined) {
  return discovery && { profiles: discovery.profiles.map(profileIdentity),
    accounts: discovery.accounts.map(account => ({ ...account, profiles: account.profiles.map(profileIdentity) })) };
}
export function rememberedVendorAccounts(db: Database, declarations: ReadonlyArray<{ id?: string; vendor?: string; account_key?: string }> = []): VendorAccount[] {
  // The newest such reading per account, each found in the partial index of migration 0064, which matches only while
  // this predicate stays exactly the same; without it this read evaluates every reading's JSON.
  const named = (column: string) => `json_valid(${column}) AND json_extract(${column}, '$.vendor_account') IS NOT NULL`;
  const rows = db.query(`SELECT (SELECT p.extra FROM probe_windows p WHERE p.provider=s.provider AND p.subject=s.subject
      AND ${named("p.extra")} ORDER BY p.ts DESC LIMIT 1) AS extra
    FROM (SELECT DISTINCT provider, subject FROM probe_windows WHERE ${named("extra")}) s`).all() as {extra:string}[];
  const accounts = rows.flatMap(row => {
    try { const a = JSON.parse(JSON.parse(row.extra).vendor_account) as VendorAccount;
      return a && ["claude", "grok", "gemini"].includes(a.vendor) && typeof a.id === "string" && typeof a.key === "string" && Array.isArray(a.profiles) && a.profiles.every(p=>p && p.vendor === a.vendor && p.key === a.key && typeof p.home === "string" && typeof p.machine === "string" && typeof p.login === "string") ? [a] : [];
    } catch { return []; }
  });
  const columns = db.query("PRAGMA table_info(claude_events)").all() as Array<{ name: string }>;
  if (columns.some(c => c.name === "account_key")) {
    // A session identity is named as the declarations name it now, not as they did at ingest.
    const claude = declarations.filter(d => ["claude", "anthropic"].includes((d.vendor ?? "").toLowerCase()) && d.id && d.account_key)
      .map(d => ({ id: d.id!, account_key: d.account_key! }));
    // Served by the partial index `claude_events_remembered_identity` (0042), which matches only
    // while this predicate stays exactly the same; without it this read scans every event.
    for (const row of db.query("SELECT DISTINCT account_key FROM claude_events WHERE account_key IS NOT NULL AND COALESCE(subscription_conflict,0)=0").all() as Array<{ account_key: string }>) {
      if (!accounts.some(a => a.key === row.account_key)) accounts.push({ id: claudeIdentitySubscription(row.account_key, claude), vendor: "claude", key: row.account_key, email: null, plan: null, current: false, profiles: [] });
    }
  }
  return accounts;
}
export function resolveVendorDiscovery(profiles: VendorProfile[], declarations: Array<{id:string;vendor?:string;account?:string}>,
  remembered: VendorAccount[] = [], machine?: string): VendorDiscovery {
  const byKey = new Map(remembered.map(a => [a.key, {...a, current:a.profiles.some(p=>p.machine !== machine)}]));
  const emailKeys = new Map<string, Set<string>>();
  for (const p of [...profiles,...remembered.flatMap(a=>a.profiles)]) if (p.key && p.email) {
    const key = `${p.vendor}:${p.email}`; const keys = emailKeys.get(key) ?? new Set(); keys.add(p.key); emailKeys.set(key, keys);
  }
  for (const p of profiles) {
    if (!p.key) continue;
    let a = byKey.get(p.key);
    if (!a) {
      const ids = new Set(declarations.filter(d => d.vendor === p.vendor && d.account?.toLowerCase() === p.email
        && emailKeys.get(`${p.vendor}:${p.email}`)?.size === 1).map(d=>d.id));
      a = {id:ids.size === 1 ? [...ids][0]! : discoveredVendorId(p), vendor:p.vendor, key:p.key, email:p.email,
        plan:p.plan, current:true, profiles:[]}; byKey.set(p.key,a);
    }
    a.current = true; a.email = p.email ?? a.email;
    a.profiles = a.profiles.filter(x=>!(x.machine === p.machine && x.home === p.home)); a.profiles.push(p);
    a.plan = newestPlanProfile(a.profiles.filter(x=>x.plan))?.plan ?? a.plan;
  }
  return {profiles,accounts:[...byKey.values()]};
}

/** `credentialsRewritten`: the probe refreshed the profile's token itself, so only the account files must be unchanged. */
function stillMatches(p: VendorProfile, credentialsRewritten = false): boolean {
  if (p.worker) return scanVendorProfiles({machine:p.machine}).some(x=>x.home === p.home && x.key === p.key);
  const current = readVendorProfile(p.vendor,p.home,p.machine,p.login);
  if (current.key !== p.key) return false;
  return credentialsRewritten && p.vendor === "claude" ? claudeAccountRevision(current.revision) === claudeAccountRevision(p.revision)
    : current.revision === p.revision;
}
const errorReading = (error: string): WindowReading => ({kind:"error", group:"-", scope:null, plan:null,
  reportedPercentSide:"used",usedPercent:null,remainingPercent:null,allowance:null,used:null,remaining:null,
  vendorPercent:null,windowMinutes:null,resetsAt:null,rateLimitReached:null,resetCredits:null,profile:null,ok:false,error,extra:null});

/** Reads only current accounts. Old Grok log records cannot be attributed from a new login. */
export async function pollVendorAccount(db: Database, account: VendorAccount, source: VendorProfile): Promise<void> {
  if (!stillMatches(source)) return;
  let readings: WindowReading[] = [];
  let ts = new Date().toISOString();
  let error = source.error;
  let credentialsRewritten = false;
  if (!error && source.vendor === "claude") {
    const parts = source.key!.split(":");
    // Only this machine's profiles get an expired token refreshed; the refresh rewrites `.credentials.json`.
    const result = await probeTarget(claudeProbeAdapter,{subscription:account.id,home:source.home,
      refreshable:!source.worker && source.machine.toLowerCase() === MACHINE.toLowerCase(),
      onCredentialsRewritten:() => { credentialsRewritten = true; },
      expectedIdentity:{accountId:parts[1] === "email" ? null : parts[1]!,organizationId:parts[2] === "personal" || parts[1] === "email" ? null : parts[2] ?? null,email:source.email}});
    readings = result.readings; error = result.error;
  } else if (!error && source.vendor === "grok") {
    const result = await probeTarget(grokProbeAdapter,{subscription:account.id,home:source.home});
    readings = result.readings; error = result.error;
    if (result.meta) {
      // A timestamp alone cannot identify a cached session that outlived a login change.
      error = "Grok Billing log has no verified account identity; quota is withheld to prevent mixing concurrent sessions.";
    }
  } else if (!error && source.worker) {
    const result = await probeTarget(geminiProbeAdapter,{...source.worker,id:account.id});
    readings = result.readings; error = result.error;
  }
  if (!stillMatches(source, credentialsRewritten)) return;
  if (error) readings = [errorReading(error)];
  // A plan read from the profile's own tier outranks the label of the token the probe used.
  const plan = (source.planTier ? source.plan : null) ?? readings.find(r=>r.plan)?.plan ?? account.plan;
  account.plan = newestPlanProfile(account.profiles.filter(p=>p.planTier && p.plan))?.plan ?? plan;
  const evidence = JSON.stringify({...account, profiles:account.profiles.map(({worker,...p})=>p)});
  if (source.vendor === "grok" && !error && db.query("SELECT 1 FROM probe_windows WHERE provider='grok' AND subject=? AND ts=? LIMIT 1").get(account.id,ts)) return;
  persistProbeWindows(db,account.vendor,account.id,ts,readings.map(r=>({...r,plan:source.planTier ? plan : r.plan ?? plan,
    profile:source.login,extra:{...r.extra,home:source.home,vendor_account:evidence}})));
}
