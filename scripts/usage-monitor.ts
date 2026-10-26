import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ARCHIVE_ROOT, CONFIG_ROOT, HOME_DIR, MACHINE, PROFILE } from "../src/config/paths";
import { resolveLocalStateRootBase, assertLocalStateOutsideRoots } from "../src/config/archive-locator";
import { scanCodexProfiles, discoveredCodexId, readCodexAccountIdentity } from "../src/providers/codex-identity";
import { scanVendorProfiles, discoveredVendorId, readVendorProfile } from "../src/providers/vendor-identity";
import { codexProbeAdapter } from "../src/providers/adapters/codex";
import { claudeProbeAdapter } from "../src/providers/adapters/claude";
import { probeTarget } from "../src/providers/core/probe";
import { acquireMonitorLease, releaseMonitorLease, openMonitorOutbox, monitorRows, queueMonitorRows, deliverMonitorRows, monitorDisplayMeters, mainAppRunning, monitorJournalTarget, recentMonitorObservation } from "./lib/usage-monitor";

export interface MonitorCollectionOptions {
  identityKeys?: readonly string[];
  intervalMinutes?: number;
  force?: boolean;
}
export async function runUsageMonitor(options: MonitorCollectionOptions = {}): Promise<Record<string, unknown>> {
const stateRoot = path.join(resolveLocalStateRootBase(), "usage-monitor");
assertLocalStateOutsideRoots(stateRoot, [ARCHIVE_ROOT, CONFIG_ROOT]);
fs.mkdirSync(stateRoot, { recursive: true });
const db = openMonitorOutbox(path.join(stateRoot, "outbox.sqlite"));
const owner = randomUUID();
const accounts: Array<{ provider: string; account: string; identity_key?: string; ts?: string; label?: string; meters?: ReturnType<typeof monitorDisplayMeters>; readings: Array<{ kind: string; group: string | null; scope?: string | null; percent: number | null; minutes?: number | null }>; error: string | null }> = [];
let report: Record<string, unknown>;
try {
  if (!acquireMonitorLease(db, owner)) throw new Error("Inny kolektor pobiera teraz dane; spróbuj za chwilę.");
  const target = monitorJournalTarget(ARCHIVE_ROOT, PROFILE);
  let handoff = await mainAppRunning();
  const retained = () => ({ delivered: 0, pending: (db.query("SELECT count(*) n FROM gauge_journal_outbox").get() as { n: number }).n, errors: [] as string[] });
  const before = handoff ? retained() : deliverMonitorRows(db);
  const seen = new Set<string>();
  const selected = (provider: string, key: string) => {
    const identity = `${provider}:${key}`;
    if (seen.has(identity) || options.identityKeys && !options.identityKeys.includes(identity)) return false;
    seen.add(identity); return true;
  };
  const recent = (provider: string, subject: string) => !options.force && options.intervalMinutes != null
    && recentMonitorObservation(db,provider,subject,options.intervalMinutes);
  const localProfile = (home: string) => {
    const relative = path.relative(HOME_DIR, home);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const codex = handoff ? [] : scanCodexProfiles().filter(p => p.identity && localProfile(p.home));
  const claude = handoff ? [] : scanVendorProfiles({ vendor: "claude", machine: MACHINE }).filter(p => p.key && localProfile(p.home));
  // Persist each result immediately so an interruption cannot lose completed provider reads.
  for (const profile of codex) {
    if (await mainAppRunning()) { handoff = true; break; }
    const identity = profile.identity!;
    if (!selected("codex",identity.key)) continue;
    const account = discoveredCodexId(identity);
    if (recent("codex",account)) continue;
    const evidence = { ...identity, subscription: account, home: profile.home, login: profile.login, machine: MACHINE };
    const result = await probeTarget(codexProbeAdapter, { account, home: profile.home, identity: evidence });
    let error = result.error;
    if (readCodexAccountIdentity(profile.home).identity?.key !== identity.key) error = "Login zmienił się podczas odczytu";
    if (!error) queueMonitorRows(db, target, monitorRows("codex", account, result.ts,
      result.readings.map(r => ({ ...r, extra: { ...r.extra, codex_account: JSON.stringify(evidence) } })), profile));
    accounts.push({ provider: "codex", account, identity_key: identity.key, ts: result.ts, label: identity.email ?? profile.login, error,
      meters: error ? [] : monitorDisplayMeters("codex", result.readings),
      readings: error ? [] : result.readings.map(r => ({ kind: r.kind, group: r.group, scope: r.scope, percent: r.usedPercent, minutes: r.windowMinutes })) });
  }
  for (const profile of claude) {
    if (handoff || await mainAppRunning()) { handoff = true; break; }
    const account = discoveredVendorId(profile);
    if (!selected("claude",profile.key!)) continue;
    if (recent("claude",account)) continue;
    const parts = profile.key!.split(":");
    const result = await probeTarget(claudeProbeAdapter, { subscription: account, home: profile.home, refreshable: true,
      expectedIdentity: { accountId: parts[1] === "email" ? null : parts[1]!,
        organizationId: parts[1] === "email" || parts[2] === "personal" ? null : parts[2] ?? null, email: profile.email } });
    let error = result.error;
    if (readVendorProfile("claude", profile.home, MACHINE, profile.login).key !== profile.key) error = "Login zmienił się podczas odczytu";
    const evidence = { id: account, vendor: "claude", key: profile.key, email: profile.email, plan: profile.plan, current: true, profiles: [profile] };
    if (!error) queueMonitorRows(db, target, monitorRows("claude", account, result.ts,
      result.readings.map(r => ({ ...r, extra: { ...r.extra, vendor_account: JSON.stringify(evidence) } })), profile));
    accounts.push({ provider: "claude", account, identity_key: profile.key!, ts: result.ts, label: profile.email ?? profile.login, error,
      meters: error ? [] : monitorDisplayMeters("claude", result.readings),
      readings: error ? [] : result.readings.map(r => ({ kind: r.kind, group: r.group, scope: r.scope, percent: r.usedPercent, minutes: r.windowMinutes })) });
  }
  // A last completed read can finish its separate journal while the main app starts.
  // Legacy work aimed at the main app's journal stays queued until it is safe to retry.
  const delivery = deliverMonitorRows(db, t => !handoff || t.journalRoot !== path.join(ARCHIVE_ROOT, "gauges", PROFILE));
  const errors = [...before.errors, ...delivery.errors];
  for (const provider of handoff || options.identityKeys ? [] : ["codex", "claude"]) {
    if (!accounts.some(a => a.provider === provider)) accounts.push({ provider, account: "", readings: [], error: "Nie znaleziono zalogowanego profilu" });
  }
  report = { at: new Date().toISOString(), accounts, handoff, observed_keys:[...seen], delivered: before.delivered + delivery.delivered, pending: delivery.pending,
    errors, ok: handoff || !errors.length && !delivery.pending && accounts.every(a => !a.error) };
  const status = path.join(stateRoot, "status.json");
  fs.writeFileSync(`${status}.${owner}`, JSON.stringify(report), { mode: 0o600 });
  fs.renameSync(`${status}.${owner}`, status);
  return report;
} catch (error) {
  return { ok: false, at: new Date().toISOString(), accounts, error: error instanceof Error ? error.message : "Błąd kolektora" };
} finally { releaseMonitorLease(db, owner); db.close(); }
}
if (import.meta.main) {
  const report = await runUsageMonitor();
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
