import type { AppContext } from "./app-context-types";
import { registerDayBounds } from "../db/usage-price-read-subscription";
import { usageLedgerScope } from "../db/usage-ledger-read";
import { usageLedgerState } from "./usage-ledger-producer";

import type { Database } from "bun:sqlite";
import { codexReadingEvidenceSql } from "../db/codex-ledger-canonical";
import type { SourceHealthResponse, SourceHealthRow } from "../shared/source-health";
import { ARCHIVE_LOGICAL_ROOT, ARCHIVE_ROOT, MACHINE } from "../config/paths";
import { queryRows } from "./data-groups";
import { readPreparedProbeProfileHealth } from "./current/probe-account-reader";
import { normEraKey } from "./eras";
import { archiveFolderOf } from "./event-source";
import { sourceHealthStatus } from "./data-clock";
import { loadAccountResolver, type AccountResolver } from "./account-resolver";
import { claudeEventAccountSql } from "./claude-event-account";
import { codexAccountSelector } from "./codex-source-account";
import { readRegisterDays } from "../db/usage-price-read-account";

type Context = Pick<AppContext, "sqlite" | "accounts" | "codexDiscovery" | "vendorDiscovery" | "resolver">;
type Usage = { vendor: string; subscription: string; source: string; last_session: string };
type Probe = { vendor: string; subscription: string; machine: string | null; profile: string | null;
  ts: string; ok: number; error: string | null };
const vendorKey = (value?: string) => ({ openai: "codex", anthropic: "claude", xai: "grok", google: "gemini", glm: "opencode" }[value ?? ""] ?? value ?? "codex");
const under = (source: string, home: string) => normEraKey(source) === normEraKey(home) || normEraKey(source).startsWith(normEraKey(home) + "/");
const later = (a: string | null, b: string | null) => !a ? b : !b ? a : a > b ? a : b;
const HOURS = 24;

/** The last session of each source and account, from the calls and the ready usage ledgers. */
export function sourceUsageFacts(db: Database, resolver: AccountResolver, accounts: Context["accounts"]): Usage[] {
  // A Claude row's subscription is the account its session identity or period names (stage 4, W4), a
  // Codex row's the period covering its source and instant (W6).
  const claudeAccount = claudeEventAccountSql(db, resolver, {});
  const codexAccount = codexAccountSelector({ sqlite: db, resolver, accounts }, "events").account({ alias: "e" });
  const queries = [
    { vendor: "codex", sql: `SELECT COALESCE(subscription,'') subscription,source,MAX(ts) last_session
      FROM (SELECT ${codexAccount.sql} subscription,e.home source,e.ts FROM events e) GROUP BY subscription,source`, params: codexAccount.params },
    { vendor: "claude", sql: `SELECT COALESCE(subscription,'') subscription,path source,MAX(ts) last_session
      FROM (SELECT ${claudeAccount.sql} subscription,path,ts FROM claude_events) GROUP BY subscription,path`, params: claudeAccount.params },
  ];
  const archival = queries.flatMap(({ vendor, sql, params }) => queryRows<Record<string, unknown>>(db, sql, params)
    .filter(row => typeof row.last_session === "string")
    .map(row => ({ vendor, subscription: String(row.subscription), source: String(row.source), last_session: String(row.last_session) })));
  const fromRegister: Usage[] = [];
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_ledger_state'").get())
    for (const provider of ["gemini","grok","glm"] as const) {
      if (usageLedgerState(db, provider)?.status !== "ready") continue;
      const head = { scope: usageLedgerScope(provider) };
      const span = registerDayBounds(db, provider, head.scope);
      if (!span.since || !span.until) continue;
      for (const row of readRegisterDays(db,head.scope,provider,resolver,{since:span.since,until:span.until}))
        if (row.source && row.last_ts)
          fromRegister.push({vendor:vendorKey(provider),subscription:row.account ?? "unassigned",
            source:`${ARCHIVE_LOGICAL_ROOT}/${row.source}`,last_session:row.last_ts});
    }
  return [...archival,...fromRegister];
}

function sourceProbes(db: Database): { rows: Probe[]; pending: boolean;
  pendingProfiles: Array<Pick<Probe, "vendor" | "subscription" | "machine" | "profile">> } {
  const prepared = readPreparedProbeProfileHealth(db);
  if (!prepared) return { rows: [], pending: true, pendingProfiles: [] };
  const rows: Probe[] = [];
  const pendingProfiles: Array<Pick<Probe, "vendor" | "subscription" | "machine" | "profile">> = [];
  for (const profile of prepared) {
    if (profile.preparing) {
      pendingProfiles.push({ vendor: profile.provider, subscription: profile.account ?? "unassigned",
        machine: profile.machine, profile: profile.profile });
      continue;
    }
    for (const [ok, reading] of [[1, profile.success], [0, profile.failure]] as const) {
      if (!reading) continue;
      rows.push({ vendor: profile.provider, subscription: profile.account ?? "unassigned",
        machine: profile.machine, profile: profile.profile, ts: reading.ts, ok,
        error: typeof reading.error === "string" ? reading.error : null });
    }
  }
  return { rows, pending: pendingProfiles.length > 0, pendingProfiles };
}

function nativeMeters(ctx: Context): Array<{ subscription: string; source: string; ts: string }> {
  // A weekly sample's subscription is the account period covering its source and instant (stage 4, W6).
  const owner = codexAccountSelector(ctx).account({ alias: "r" });
  return queryRows<{ subscription: string; source: string; ts: string }>(ctx.sqlite,
    `SELECT subscription,source,MAX(ts) ts FROM (SELECT ${owner.sql} subscription,r.home source,r.ts FROM ratelimit r
      WHERE r.used_percent IS NOT NULL AND r.window_minutes=10080 AND r.limit_id='codex' AND ${codexReadingEvidenceSql(ctx.sqlite, "r")})
      WHERE subscription IS NOT NULL GROUP BY subscription,source`, owner.params);
}

function archiveSource(source: string, vendor: string, root: string): string | null {
  if (!under(source, root)) return null;
  const normalized = source.replace(/\\/g, "/"), prefix = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.slice(prefix.length + 1).split("/");
  if (parts[0]?.toLowerCase() === vendor && parts[1]) return `${prefix}/${parts.slice(0, 2).join("/")}`;
  return null;
}

function sourceInventory(ctx: Context, now: string, localMachine: string) {
  const sources: SourceHealthRow[] = [];
  const declarations = ctx.accounts.sources;
  const make = (vendor: string, subscription: string, machine: string | null, profile: string | null, archive: string | null): SourceHealthRow => ({
    key: JSON.stringify([vendor, subscription, machine, profile, archive, sources.length]), vendor, subscription,
    label: ctx.accounts.subscriptions.find(d => vendorKey(d.vendor) === vendor && normEraKey(d.id) === normEraKey(subscription))?.account
      ?? ctx.codexDiscovery?.accounts.find(a => vendor === "codex" && a.id === subscription)?.email
      ?? ctx.vendorDiscovery?.accounts.find(a => a.vendor === vendor && a.id === subscription)?.email ?? subscription,
    machine, profile, archive, configured: false, historical: false,
    local: !!machine && normEraKey(machine) === normEraKey(localMachine),
    last_session: null, last_meter: null, last_attempt: null, error: null, status: "unknown",
  });
  for (const declaration of declarations) {
    const folder = archiveFolderOf(declaration.home, ARCHIVE_LOGICAL_ROOT);
    const owner = folder ? (ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.accounts.subscriptions))
      .resolve(declaration.vendor, folder.key, null, now).account : null;
    const row = make(vendorKey(declaration.vendor), owner ?? "unassigned", declaration.machine ?? null,
      declaration.source_home ?? null, declaration.home ?? null);
    row.configured = !!declaration.home;
    // A physical route remains editable on its own machine even across an account-period gap.
    row.historical = false;
    sources.push(row);
  }
  const candidates = (vendor: string, id: string) => sources.filter(row => row.vendor === vendor && normEraKey(row.subscription) === normEraKey(id || "unassigned"));
  const locateProfile = (vendor: string, id: string, machine: string | null, profile: string | null) => {
    const rows = candidates(vendor, id).filter(row => !row.historical && normEraKey(row.machine) === normEraKey(machine));
    const exact = rows.filter(row => normEraKey(row.profile) === normEraKey(profile));
    if (exact.length === 1) return exact[0]!;
    const row = make(vendor, id, machine, profile, null); sources.push(row); return row;
  };
  for (const account of ctx.codexDiscovery?.accounts ?? []) {
    for (const profile of account.profiles) {
      const row = locateProfile("codex", account.id, profile.machine, profile.home);
      row.label = account.email ?? row.label;
    }
  }
  for (const account of ctx.vendorDiscovery?.accounts ?? []) {
    for (const profile of account.profiles) {
      const row = locateProfile(account.vendor, account.id, profile.machine, profile.home);
      row.label = account.email ?? row.label;
    }
  }
  return { sources, declarations, make, candidates, locateProfile };
}

/** Configuration is available without reading event history or waiting for report preparation. */
export function buildSourceInventory(ctx: Context, now = new Date().toISOString(), localMachine = MACHINE): SourceHealthResponse {
  const { sources } = sourceInventory(ctx, now, localMachine);
  for (const row of sources) row.status = row.historical ? "history" : row.configured ? "configured"
    : row.profile && ["codex", "claude"].includes(row.vendor) ? "missing-assignment" : "unknown";
  return { generated_at: now, local_machine: localMachine, older_after_hours: HOURS, activity_pending: true, sources };
}

export function buildSourceHealth(ctx: Context, now = new Date().toISOString(), localMachine = MACHINE, archiveRoot = ARCHIVE_ROOT): SourceHealthResponse {
  const { sources, declarations, make, candidates, locateProfile } = sourceInventory(ctx, now, localMachine);
  const probes = sourceProbes(ctx.sqlite);
  for (const probe of probes.rows) {
    const row = locateProfile(vendorKey(probe.vendor), probe.subscription, probe.machine, probe.profile);
    row.last_attempt = later(row.last_attempt, probe.ts);
    if (probe.ok) row.last_meter = later(row.last_meter, probe.ts);
    if (!probe.ok && row.last_attempt === probe.ts) row.error = probe.error || "Meter reading failed";
  }
  for (const profile of probes.pendingProfiles) {
    locateProfile(profile.vendor, profile.subscription, profile.machine, profile.profile).activity_pending = true;
  }
  for (const usage of sourceUsageFacts(ctx.sqlite, ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.accounts.subscriptions), ctx.accounts)) {
    let matches = candidates(usage.vendor, usage.subscription).filter(row => row.archive && under(usage.source, row.archive));
    if (matches.length > 1) {
      matches = matches.filter(row => declarations.some(d => d.home === row.archive &&
        (ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.accounts.subscriptions))
          .resolve(d.vendor, archiveFolderOf(d.home, ARCHIVE_LOGICAL_ROOT)?.key ?? "", null, usage.last_session).account === row.subscription));
    }
    if (matches.length !== 1) {
      const root = archiveSource(usage.source, usage.vendor, archiveRoot);
      const partition = root?.split("/").at(-1) ?? (usage.vendor === "opencode" ? usage.source : "");
      const machines = [...new Set(sources.flatMap(row => row.machine ? [row.machine] : []))].sort((a, b) => b.length - a.length);
      // Only the archive's documented machine partition supplies provenance; arbitrary local paths cannot.
      const machine = machines.find(machine => normEraKey(partition) === normEraKey(machine) || normEraKey(partition).startsWith(normEraKey(machine) + "-")) ?? null;
      let row = candidates(usage.vendor, usage.subscription).find(row => row.archive === root && row.machine === machine);
      if (!row && root && machine && normEraKey(partition) === normEraKey(machine)) {
        row = candidates(usage.vendor, usage.subscription).find(row => !row.archive && row.machine === machine &&
          normEraKey(row.profile).endsWith(`/.${usage.vendor}`));
        if (row) row.archive = root;
      }
      if (!row) { row = make(usage.vendor, usage.subscription || "unassigned", machine, null, root); sources.push(row); }
      matches = [row];
    }
    for (const row of matches) row.last_session = later(row.last_session, usage.last_session);
  }
  for (const meter of nativeMeters(ctx)) {
    const matches = candidates("codex", meter.subscription).filter(row => row.archive && under(meter.source, row.archive));
    if (matches.length === 1) matches[0]!.last_meter = later(matches[0]!.last_meter, meter.ts);
  }
  for (const row of sources) {
    if (probes.pending && !probes.pendingProfiles.length) row.activity_pending = true;
    if (row.last_meter && (!row.last_attempt || row.last_meter >= row.last_attempt)) row.error = null;
    const profiles = row.vendor === "codex" ? ctx.codexDiscovery?.profiles : ctx.vendorDiscovery?.profiles.filter(profile => profile.vendor === row.vendor);
    const profileError = profiles?.find(profile => normEraKey(profile.machine) === normEraKey(row.machine) && normEraKey(profile.home) === normEraKey(row.profile))?.error;
    if (profileError) row.error = profileError;
    row.status = sourceHealthStatus(row,Date.parse(now),HOURS);
  }
  return { generated_at: now, local_machine: localMachine, older_after_hours: HOURS,
    activity_pending: probes.pending,
    sources: sources.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label) || (a.machine ?? "").localeCompare(b.machine ?? "")) };
}

export function handleSourceHealth(ctx: AppContext): Response { return Response.json(buildSourceHealth(ctx)); }
