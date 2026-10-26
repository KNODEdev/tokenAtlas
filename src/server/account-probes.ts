import { codexHeadlineWindowMinutes } from "../shared/codex-counters";
import type { AppContext } from "./app-context-types";
import { resolveSubscription, accountResolverOf } from "./account-scope";
import { discoverCodexHome, runProbeCycle } from "../providers/adapters/codex";
import type { ProbeTarget } from "../providers/adapters/codex";
import { MACHINE, ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import fs from "fs";
import path from "path";
import { archiveFolderOf } from "./event-source";
import type { Database } from "../db/sqlite";
import { resolveCodexDiscovery, rememberedCodexAccounts } from "./codex-discovery";
import { readLatestAccountStateRows } from "./latest-account-state-query";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { preparingDataResponse } from "./preparing-response";
import { allProbeHealth } from "./probe-health";
import { firstImportPending } from "./server-bootstrap";
import { resolveVendorDiscovery, rememberedVendorAccounts } from "./vendor-discovery";

export interface AccountStateRow {
  account: string;
  limit_id: string;
  limit_name: string | null;
  plan_type: string | null;
  slot: string;
  window_minutes: number | null;
  used_percent: number;
  resets_at: number | null;
  resets_at_iso: string | null;
  rate_limit_reached: boolean;
  reset_credits: number;
  ts: string;
  age_minutes: number;
  machine: string | null;
}

/**
 * The label a probe cycle should stamp on its samples right now: the era that
 * currently owns the subscription's source. Null means "do not probe": either
 * the declaration was rejected, or the source is declared but no era covers
 * today, and labelling a fresh sample with a closed subscription would be the
 * silent mis-attribution eras exist to stop. The configured id survives only
 * when nothing declares that source at all (legacy, era-free setups).
 */
export function currentProbeSubscription(
  ctx: AppContext,
  vendor: string,
  configured: string
): string | null {
  if (ctx.eraErrors.length > 0) return null;
  const now = new Date().toISOString();
  for (const entry of ctx.eras.entriesOf(configured)) {
    for (const source of [entry.source_home, entry.home]) {
      if (!source) continue;
      const id = resolveSubscription(ctx, vendor, source, now);
      if (id) return id;
    }
  }
  const direct = resolveSubscription(ctx, vendor, configured, now);
  if (direct) return direct;
  return ctx.eras.erasFor(vendor, configured).length > 0 ? null : configured;
}

/**
 * Wraps currentProbeSubscription for a poller: returns the label to stamp, or
 * null to skip this cycle. Probing runs on a timer, so the skip is logged on
 * the transition into it rather than every few minutes.
 */
export function probeSubscriptionGate(
  ctx: AppContext,
  vendor: string,
  configured: string
): () => string | null {
  let warned = false;
  return () => {
    const id = currentProbeSubscription(ctx, vendor, configured);
    if (id != null) {
      warned = false;
      return id;
    }
    if (!warned) {
      warned = true;
      console.warn(
        `[tokenAtlas ${vendor}-probe] pomijam cykle: ` +
          (ctx.eraErrors.length > 0
            ? "deklaracja er odrzucona"
            : `żadna era nie obejmuje dziś źródła subskrypcji ${configured}`)
      );
    }
    return null;
  };
}

export function probeTargets(
  ctx: AppContext,
  at: string = new Date().toISOString(),
  discoverHome: typeof discoverCodexHome = discoverCodexHome
): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  // A rejected declaration must not reach attribution at all: with two eras
  // overlapping on one home, resolution is ambiguous and any fallback would
  // write the same samples under both subscriptions.
  if (ctx.eraErrors.length > 0) return out;
  if (ctx.codexDiscovery) {
    for (const account of ctx.codexDiscovery.accounts) {
      const source = account.profiles.find(p => p.machine === MACHINE && ctx.codexDiscovery!.profiles.some(
        local => local.home === p.home && local.identity?.key === account.key));
      if (source) out.push({ account: account.id, home: source.home, identity: source });
    }
    return out;
  }
  const seen = new Set<string>();
  for (const sub of ctx.accounts.sources) {
    if (sub.vendor !== "codex") continue;
    const sameMachine = !sub.machine || sub.machine.toUpperCase() === MACHINE.toUpperCase();
    if (!sameMachine) continue;
    const sourceHome = sub.source_home;
    if (!sourceHome || !(ctx.probeSourceExists ?? fs.existsSync)(sourceHome)) continue;
    const key = path.resolve(sourceHome).toLowerCase();
    if (seen.has(key)) continue;
    // A probe reads the source as it is right now, so it belongs to the era
    // that covers now; a closed era's home is somebody else's source today.
    // Discovery proves the local account; the archive declaration still owns
    // attribution, without adding colliding local paths from different PCs.
    const sourceKey = archiveFolderOf(sub.home, ARCHIVE_LOGICAL_ROOT)?.key;
    const account = sourceKey ? accountResolverOf(ctx).resolve("codex", sourceKey, null, at).account : null;
    if (!account) continue;
    seen.add(key);
    out.push({ account, home: sourceHome });
  }
  return out;
}

export type CodexProbeRunner = (
  sqlite: Database,
  targets: ProbeTarget[],
  options: { onError: (error: { account: string; error: string }) => void }
) => Promise<unknown>;

export async function runCodexProbePoll(
  ctx: AppContext,
  at: string = new Date().toISOString(),
  runner: CodexProbeRunner = runProbeCycle
): Promise<void> {
  refreshCodexDiscovery(ctx);
  const targets = probeTargets(ctx, at);
  if (targets.length === 0) return;
  await runner(ctx.sqlite, targets, {
    onError: (error) => console.warn(`[tokenAtlas probe] ${error.account}: ${error.error}`),
  });
  // New readings and the discovered accounts move only the stamps of the routes that read them (cache.ts),
  // as for the other providers' probes; every other remembered response stays valid.
  ctx.responseCache?.invalidateReadings();
}

export function refreshCodexDiscovery(ctx: AppContext): void {
  if (!ctx.scanCodexProfiles) return;
  ctx.codexDiscovery = resolveCodexDiscovery(ctx.scanCodexProfiles(), ctx.accounts.subscriptions ?? [],
    rememberedCodexAccounts(ctx.sqlite), MACHINE);
  ctx.responseCache?.invalidateReadings();
}

export function latestAccountState(ctx: AppContext): AccountStateRow[] {
  let rows: Array<{
    account: string;
    limit_id: string;
    limit_name: string | null;
    plan_type: string | null;
    slot: string;
    window_minutes: number | null;
    used_percent: number;
    resets_at: string | null;
    rate_limit_reached: number;
    reset_credits: number;
    ts: string;
    machine: string | null;
  }> = [];
  try {
    rows = readLatestAccountStateRows(ctx.sqlite);
  } catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) throw error;
    return [];
  }
  const nowMs = Date.now();
  return rows.map((r) => {
    const resetEpoch = r.resets_at == null ? null : Date.parse(r.resets_at) / 1000;
    return {
      account: r.account,
      limit_id: r.limit_id,
      limit_name: r.limit_name,
      plan_type: r.plan_type,
      slot: r.slot,
      window_minutes: r.window_minutes,
      used_percent: r.used_percent,
      resets_at: resetEpoch,
      resets_at_iso: resetEpoch != null ? new Date(resetEpoch * 1000).toISOString() : null,
      rate_limit_reached: r.rate_limit_reached === 1,
      reset_credits: r.reset_credits,
      ts: r.ts,
      age_minutes: Math.round(((nowMs - new Date(r.ts).getTime()) / 60_000) * 10) / 10,
      machine: r.machine,
    };
  });
}

export function selectCodexPlanState(
  rows: AccountStateRow[],
  account: string,
  headlineWindowMinutes: number
): { live: AccountStateRow | null; other: AccountStateRow[] } {
  const accountRows = rows.filter((row) => row.account === account);
  headlineWindowMinutes = codexHeadlineWindowMinutes(accountRows, headlineWindowMinutes);
  const live =
    accountRows.find(
      (row) => row.limit_id === "codex" && row.window_minutes === headlineWindowMinutes
    ) ??
    accountRows.find(
      (row) => row.limit_id === "codex" && row.window_minutes == null && row.slot === "primary"
    ) ??
    null;
  return { live, other: accountRows.filter((row) => row !== live) };
}

export async function handleAccountState(ctx: AppContext, req: Request): Promise<Response> {
  try {
    if (req.method === "POST") {
      if (firstImportPending) return preparingDataResponse();
      const result = await runProbeCycle(ctx.sqlite, probeTargets(ctx));
      return Response.json({ probe: result, rows: latestAccountState(ctx) });
    }
    return Response.json({
      probeable: probeTargets(ctx).map((t) => t.account),
      rows: latestAccountState(ctx),
      probes: allProbeHealth(ctx.sqlite),
    });
  } catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) return preparingDataResponse();
    throw error;
  }
}

export function refreshVendorDiscovery(ctx: AppContext): void {
  if (!ctx.scanVendorProfiles) return;
  ctx.vendorDiscovery = resolveVendorDiscovery(ctx.scanVendorProfiles(),ctx.accounts.subscriptions ?? [],rememberedVendorAccounts(ctx.sqlite,ctx.accounts.subscriptions),MACHINE);
  ctx.responseCache?.invalidateReadings();
}
