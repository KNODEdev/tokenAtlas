import { queryRows } from "./data-groups";
import { readLedgerTotals, requireUsageLedgerSums } from "./ledger-sums";
import type { AppContext } from "./app-context-types";
import { normPath, planLabel, accountResolverOf } from "./account-scope";
import { normEraVendor, declaredVendorAccount } from "./eras";
import { claudeAccountId } from "./claude-limit";
import { codexAccountSelector } from "./codex-source-account";
import { codexEventOwnerOf } from "./codex-event-owner";
import { claudeAccountHistoryFromLedger, claudeEventAccountSql, claudeEventOwnedBySql } from "./claude-event-account";
import { probeWindowColumns, hasQualifyingProbeWindow } from "./account-probe-availability";
import { latestAccountState, selectCodexPlanState } from "./account-probes";
import { readPreparedProbeActivity, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";

interface AccountSourceStats {
  rows: number;
  firstTs: string | null;
  lastTs: string | null;
  windows: Set<number>;
  limitIds: Set<string>;
}

function accountSourceStats(ctx: AppContext): {
  ratelimit: Map<string, AccountSourceStats>;
  events: Map<string, AccountSourceStats>;
} {
  const ratelimit = new Map<string, AccountSourceStats>();
  const events = new Map<string, AccountSourceStats>();
  const get = (map: Map<string, AccountSourceStats>, home: string): AccountSourceStats => {
    const key = normPath(home);
    const current = map.get(key);
    if (current) return current;
    const created = { rows: 0, firstTs: null, lastTs: null, windows: new Set<number>(), limitIds: new Set<string>() };
    map.set(key, created);
    return created;
  };
  try {
    const rows = queryRows(ctx.sqlite, `SELECT home, window_minutes, limit_id, COUNT(*) AS rows, MIN(ts) AS first_ts, MAX(ts) AS last_ts
           FROM ratelimit
          GROUP BY home, window_minutes, limit_id`) as Array<{
      home: string;
      window_minutes: number | null;
      limit_id: string | null;
      rows: number;
      first_ts: string | null;
      last_ts: string | null;
    }>;
    for (const row of rows) {
      const stat = get(ratelimit, row.home);
      stat.rows += row.rows;
      if (row.window_minutes != null) stat.windows.add(row.window_minutes);
      if (row.limit_id != null) stat.limitIds.add(row.limit_id);
      if (row.first_ts && (!stat.firstTs || row.first_ts < stat.firstTs)) stat.firstTs = row.first_ts;
      if (row.last_ts && (!stat.lastTs || row.last_ts > stat.lastTs)) stat.lastTs = row.last_ts;
    }
  } catch {
  }
  {
    // Recorded calls per Codex home, from the ledger (a ledger still preparing makes the view wait).
    const rows = new Map<string, { home: string; rows: number; first_ts: string | null; last_ts: string | null }>();
    for (const sum of readLedgerTotals(ctx.sqlite, ["codex"], "home")) {
      const home = sum.key ?? "", row = rows.get(home) ?? { home, rows: 0, first_ts: null, last_ts: null };
      row.rows += sum.calls;
      if (!row.first_ts || sum.first_ts < row.first_ts) row.first_ts = sum.first_ts;
      if (!row.last_ts || sum.last_ts > row.last_ts) row.last_ts = sum.last_ts;
      rows.set(home, row);
    }
    for (const row of rows.values()) {
      const stat = get(events, row.home);
      stat.rows += row.rows;
      stat.firstTs = row.first_ts;
      stat.lastTs = row.last_ts;
    }
  }
  return { ratelimit, events };
}

export function handleAccounts(ctx: AppContext): Response {
  const sourceStats = accountSourceStats(ctx);
  const probeColumns = probeWindowColumns(ctx.sqlite);
  const out: AccountEntry[] = (ctx.accounts.subscriptions || [])
    .filter((sub) => normEraVendor(sub.vendor) !== "claude" || claudeAccountId(sub.id) !== null)
    .map((sub): AccountEntry => {
    const declared = ctx.subIdToHomes.get(sub.id.toLowerCase()) || [];
    const homes = declared.map(normPath);
    const source = ctx.accounts.sources.find(row => declared.some(home => normPath(home) === normPath(row.home)));
    let ratelimitRows = 0;
    let eventRows = 0;
    let windows: number[] = [];
    let limitIds: string[] = [];
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    const windowSet = new Set<number>();
    const limitIdSet = new Set<string>();
    for (const home of homes) {
      const rate = sourceStats.ratelimit.get(home);
      if (rate) {
        ratelimitRows += rate.rows;
        for (const window of rate.windows) windowSet.add(window);
        for (const limitId of rate.limitIds) limitIdSet.add(limitId);
      }
      const event = sourceStats.events.get(home);
      if (event) {
        eventRows += event.rows;
        if (event.firstTs && (!firstTs || event.firstTs < firstTs)) firstTs = event.firstTs;
        if (event.lastTs && (!lastTs || event.lastTs > lastTs)) lastTs = event.lastTs;
      }
    }
    windows = [...windowSet].sort((a, b) => b - a);
    limitIds = [...limitIdSet].sort();
    const probeProvider = normEraVendor(sub.vendor);
    const hasProviderGauge =
      ["claude", "gemini", "glm", "grok"].includes(probeProvider)
        ? hasQualifyingProbeWindow(ctx.sqlite, probeProvider, sub.id, probeColumns)
        : false;
    return {
      id: sub.id,
      label: planLabel(sub, ctx),
      vendor: sub.vendor || null,
      plan: null,
      login: source?.login || null,
      machine: source?.machine || null,
      note: sub.note || null,
      declared_account: sub.account?.trim() || null,
      homes,
      ratelimit_rows: ratelimitRows,
      event_rows: eventRows,
      windows,
      limit_ids: limitIds,
      first_event_ts: firstTs,
      last_event_ts: lastTs,
      has_gauge: ratelimitRows > 0 || hasProviderGauge,
      has_events: eventRows > 0,
    };
  });
  if (ctx.sqlite && (ctx.sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).some(c => c.name === "billing_mode")) {
    // A pool's account is the period covering each business row's source and instant.
    const selector = codexAccountSelector(ctx, "events");
    const owner = codexEventOwnerOf(ctx.sqlite, selector, { alias: "e" });
    const pools = queryRows<{ id: string; n: number; first: string; last: string }>(ctx.sqlite,
      `SELECT ${owner.sql} AS id, COUNT(*) AS n, MIN(e.ts) AS first, MAX(e.ts) AS last FROM events e WHERE e.billing_mode='business_credits' GROUP BY 1`,
      owner.params);
    for (const pool of pools) {
      const declared = out.find(row => row.id === pool.id);
      const entry: AccountEntry = { id: pool.id, label: declared?.declared_account ?? "Business · credits",
        vendor: "codex", plan: "self_serve_business_usage_based", login: null, machine: null,
        note: declared?.note ?? "Usage-based Business recorded in transcripts; workspace identity not present.",
        declared_account: declared?.declared_account ?? null, homes: [], ratelimit_rows: 0, event_rows: pool.n,
        windows: [], limit_ids: [], first_event_ts: pool.first, last_event_ts: pool.last, has_gauge: false, has_events: true };
      if (declared) Object.assign(declared, entry); else out.push(entry);
    }
  }
  const claudeEntry = claudeSubscription(ctx, probeColumns);
  if (claudeEntry) out.push(claudeEntry);
  const resolver = accountResolverOf(ctx);
  // From the usage ledger's day sums (every Claude event read took 0.8-1.7 s); from the events until it is published.
  const claudeHistory = claudeAccountHistoryFromLedger(ctx.sqlite, resolver, () => requireUsageLedgerSums(ctx.sqlite, "claude")) ?? (() => {
    const account = claudeEventAccountSql(ctx.sqlite, resolver, {});
    return queryRows<{ id: string; n: number; first: string; last: string }>(ctx.sqlite, `SELECT id,count(*) n,min(ts) first,max(ts) last
      FROM (SELECT ${account.sql} id,ts FROM claude_events) WHERE id IS NOT NULL GROUP BY id`, account.params);
  })();
  for (const row of claudeHistory) {
    if (!claudeAccountId(row.id)) continue;
    const entry = out.find(a => normEraVendor(a.vendor) === "claude" && a.id.toLowerCase() === row.id);
    const facts = { event_rows: row.n, first_event_ts: row.first, last_event_ts: row.last, has_events: true };
    if (entry) Object.assign(entry, facts);
    else out.push({ id: row.id, label: row.id, vendor: "claude", plan: null, login: null, machine: null, note: "Account recorded in archived sessions", declared_account: null, homes: [], ratelimit_rows: 0, windows: [], limit_ids: [], has_gauge: hasQualifyingProbeWindow(ctx.sqlite, "claude", row.id, probeColumns), ...facts });
  }
  for (const account of ctx.vendorDiscovery?.accounts ?? []) {
    if (normEraVendor(account.vendor) === "claude" && !claudeAccountId(account.id)) continue;
    for (const profile of account.profiles) {
      const history = out.find(row => row.id === account.id);
      for (let i=out.length-1;i>=0;i--) if (out[i]!.vendor === account.vendor && out[i]!.id === account.id && out[i]!.machine === profile.machine && out[i]!.login === profile.login) out.splice(i,1);
      out.push({id:account.id,label:account.email ?? account.id,vendor:account.vendor,plan:account.plan,
        login:profile.login,machine:profile.machine,note:profile.error ?? `Detected ${profile.surface} account; historical assignments are unchanged.`,
        declared_account:account.email,homes:[profile.home],ratelimit_rows:history?.ratelimit_rows ?? 0,event_rows:history?.event_rows ?? 0,
        windows:[],limit_ids:[],first_event_ts:history?.first_event_ts ?? null,last_event_ts:history?.last_event_ts ?? null,
        has_gauge:hasQualifyingProbeWindow(ctx.sqlite,account.vendor,account.id,probeColumns),has_events:history?.has_events ?? false});
    }
  }
  const codexState = ctx.codexDiscovery ? latestAccountState(ctx) : [];
  for (const account of ctx.codexDiscovery?.accounts ?? []) {
    const state = selectCodexPlanState(codexState, account.id, 10080).live;
    const history = out.find(row => row.id === account.id);
    for (const profile of account.profiles) {
      for (let i = out.length - 1; i >= 0; i--) {
        const declared = out[i]!;
        if (declared.vendor === "codex" && declared.id === account.id && declared.machine === profile.machine && declared.login === profile.login) out.splice(i, 1);
      }
      out.push({ id: account.id, label: account.email ?? account.id, vendor: "codex", plan: state?.plan_type ?? null,
        login: profile.login, machine: profile.machine, note: "Automatically observed ChatGPT login; historical assignments are unchanged.",
        declared_account: account.email, homes: [profile.home], ratelimit_rows: history?.ratelimit_rows ?? 0, event_rows: history?.event_rows ?? 0,
        windows: state?.window_minutes ? [state.window_minutes] : [], limit_ids: state ? [state.limit_id] : [],
        first_event_ts: history?.first_event_ts ?? null, last_event_ts: history?.last_event_ts ?? null,
        has_gauge: state != null || history?.has_gauge === true, has_events: history?.has_events ?? false });
    }
  }
  return Response.json({
    count: out.length,
    subscriptions: out,
    discovery_diagnostics: ctx.vendorDiscovery?.profiles.filter(p=>p.error).map(p=>({vendor:p.vendor,login:p.login,machine:p.machine,error:p.error})) ?? [],
  });
}

export interface AccountEntry {
  id: string;
  label: string;
  vendor: string | null;
  plan: string | null;
  login: string | null;
  machine: string | null;
  note: string | null;
  declared_account: string | null;
  homes: string[];
  ratelimit_rows: number;
  event_rows: number;
  windows: number[];
  limit_ids: string[];
  first_event_ts: string | null;
  last_event_ts: string | null;
  has_gauge: boolean;
  has_events: boolean;
}

function claudeSubscription(ctx: AppContext, probeColumns = probeWindowColumns(ctx.sqlite)): AccountEntry | null {
  const cfg = ctx.claudeGauge;
  if (!cfg) return null;
  const id = claudeAccountId(cfg.subscription);
  if (!id) return null;
  let calls = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  try {
    const resolver = accountResolverOf(ctx);
    const owned = claudeEventOwnedBySql(ctx.sqlite, resolver, id, {});
    const row = queryRows<{ c: number; a: string | null; b: string | null }>(ctx.sqlite,
      `SELECT count(*) AS c, min(ts) AS a, max(ts) AS b FROM claude_events WHERE ${owned.sql}`, owned.params)[0] ?? { c: 0, a: null, b: null };
    calls = row.c ?? 0;
    firstTs = row.a;
    lastTs = row.b;
  } catch {
  }
  const activity = readPreparedProbeActivity(ctx.sqlite, "claude", id);
  if (!activity) throw new ProbeAccountIndexUnavailable();
  const probeRows = activity.reduce((sum, day) => sum + day.samples, 0);
  return {
    id,
    label: id,
    vendor: cfg.vendor || "claude",
    plan: null,
    login: null,
    machine: null,
    note:
      probeRows > 0
        ? "procent czytany z konta (GET /api/oauth/usage); z claude-gauge.json pochodzi już tylko przelicznik punktu na dolary"
        : "pułap deklarowany w claude-gauge.json - probe konta jeszcze nie odpowiedział, więc procent jest wyliczony ze zmierzonego zużycia i kosztu punktu",
    declared_account: declaredVendorAccount(ctx.accounts.subscriptions || [], id),
    homes: [],
    ratelimit_rows: probeRows,
    event_rows: calls,
    windows: cfg.window_hours ? [cfg.window_hours * 60] : [],
    limit_ids: [],
    first_event_ts: firstTs,
    last_event_ts: lastTs,
    has_gauge: hasQualifyingProbeWindow(ctx.sqlite, "claude", id, probeColumns),
    has_events: calls > 0,
  };
}
