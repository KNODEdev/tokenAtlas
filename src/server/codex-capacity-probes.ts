import type { Database } from "bun:sqlite";
import type { CodexProbe } from "./codex-calibration";
import { queryRows } from "./data-groups";
import { codexReadingEvidenceSql } from "../db/codex-ledger-canonical";
import { sortByInstant } from "./instant-order";

export type CapacityMeterModels = ReadonlyMap<string, Array<{reset:number;spark:boolean;main:boolean}>>;

/**
 * Unlike historical traffic anchors, these are actual percentage observations. `owner` is the account
 * of a home at an instant (`CodexAccountSelector.accountAt`); a sample no period owns is left out.
 */
export function loadCapacitySessionProbes(db: Database, since: string, until: string,
  owner: (home: string, ts: string) => string | null, sparkPaths = new Set<string>(), windowMinutes = 10080,
  meterModels:CapacityMeterModels=new Map()): CodexProbe[] {
  const columns = new Set((db.query("PRAGMA table_info(ratelimit)").all() as { name: string }[]).map(r => r.name));
  if (!["home", "path", "ts", "used_percent", "resets_at", "window_minutes", "limit_id"].every(c => columns.has(c))) return [];
  const rows = queryRows<{home:string;path:string;ts:string;used_percent:number;resets_at:number;plan:string|null}>(db, `SELECT r.home,r.path,r.ts,r.used_percent,r.resets_at,
    ${columns.has("plan_type") ? "r.plan_type" : "NULL"} AS plan
    FROM ratelimit r
    WHERE r.limit_id='codex' AND r.window_minutes=? AND r.used_percent BETWEEN 0 AND 100
    AND r.resets_at IS NOT NULL AND r.ts >= ? AND r.ts < ? AND ${codexReadingEvidenceSql(db, "r")} ORDER BY r.ts, r.rowid`, [windowMinutes,since,until], ["ts"]);
  const probes: CodexProbe[] = [];
  for (const row of rows) {
    // Older Spark sessions mislabeled their separate allowance as the main counter.
    const pathKey=JSON.stringify([row.home,row.path]);
    if (sparkPaths.has(pathKey)) continue;
    // A rollout can switch from Spark to a main model. Its clocks stay separate,
    // including when old logs label both allowances as "codex".
    const clockModels=meterModels.get(pathKey)?.filter(model=>Math.abs(model.reset-row.resets_at)<=120)??[];
    if(clockModels.some(model=>model.spark) && !clockModels.some(model=>model.main))continue;
    const account = owner(row.home, row.ts);
    if (!account || !Number.isFinite(row.resets_at) || !Number.isFinite(Date.parse(row.ts))) continue;
    const reset = new Date(row.resets_at * 1000);
    if (!Number.isFinite(reset.getTime()) || reset.getTime() <= Date.parse(row.ts)) continue;
    probes.push({ subject: account.toLowerCase(), ts: row.ts, used_percent: row.used_percent,
      resets_at: reset.toISOString(), kind: "session", window_minutes: windowMinutes, plan: row.plan?.toLowerCase() ?? null,
      home: row.home, path: row.path });
  }
  return probes;
}

/** Resolve second-level clock wobble without joining different reset cycles. */
export function mergeCapacityProbes(periodic: CodexProbe[], sessions: CodexProbe[], windowMinutes = 10080,
  options: { preserveDrops?: boolean } = {}) {
  const duration = windowMinutes * 60000;
  const groups: Array<{ subject: string; anchor: number; probes: CodexProbe[]; key: string }> = [];
  let tieList = -1, tieTs: string | null = null, tie = 0;
  for (const [list, p] of [...periodic.map(p => [0, p] as const), ...sessions.map(p => [1, p] as const)]) {
    // A group's creation key orders it among groups exactly as this loop creates them: by input list,
    // reading time and position among equal times. It stays the same in any time-bounded input.
    if (list === tieList && p.ts === tieTs) tie++; else { tieList = list; tieTs = p.ts; tie = 0; }
    if (p.window_minutes !== windowMinutes || !p.resets_at || !Number.isFinite(Date.parse(p.resets_at))) continue;
    const anchor = Date.parse(p.resets_at);
    let group = groups.find(g => g.subject === p.subject && Math.abs(g.anchor - anchor) <= 120000);
    if (!group) { group = { subject: p.subject, anchor, probes: [], key: `${list}|${p.ts}|${String(tie).padStart(6, "0")}` }; groups.push(group); }
    group.probes.push(p);
  }
  let conflictingReadings = 0;
  const confirmed = groups.filter(g => g.probes.some(p => p.kind !== "session"));
  const evidence = groups.map(group => {
    const ordered = sortByInstant([...group.probes], p => p.ts);
    return { group, ordered, times: ordered.map(p => Date.parse(p.ts)), first: Date.parse(ordered[0]!.ts), last: Date.parse(ordered.at(-1)!.ts),
      peak: Math.max(...ordered.map(p => p.used_percent)), plans: new Set(ordered.map(p => p.plan)) };
  });
  const output = (group: typeof groups[number]): CodexProbe[] => {
    const ownPeriodic = group.probes.filter(p => p.kind !== "session");
    // Do not let an unconfirmed parallel session clock replace an account-level
    // clock observed over that same time. Gaps without probes can still add cycles.
    if (!ownPeriodic.length && confirmed.some(g => g.subject === group.subject
      && group.anchor - duration >= g.anchor - duration
      && group.anchor - duration < Math.max(...g.probes.filter(p => p.kind !== "session").map(p => Date.parse(p.ts))))) {
      conflictingReadings += group.probes.length;
      return [];
    }
    // Empty placeholder windows can move with polling time. A continuing,
    // nonempty account counter on both sides disproves such a reset.
    const emptyClock = group.probes.every(p => p.used_percent === 0);
    const ownEvidence = evidence.find(e => e.group === group)!;
    if (emptyClock && evidence.some(other => other.group.subject === group.subject
      && other.group !== group && other.first < ownEvidence.first && other.last > ownEvidence.last
      && other.ordered.some(p => Date.parse(p.ts) < ownEvidence.first && p.used_percent > 0)
      && other.ordered.some(p => Date.parse(p.ts) > ownEvidence.last && p.used_percent > 0)
      && other.group.anchor > ownEvidence.last)) {
      conflictingReadings += group.probes.length;
      return [];
    }
    // A parallel clock is not an early reset when the older counter continues
    // to advance beyond it. Stale repeats of an old peak do not qualify.
    const own = evidence.find(e => e.group === group)!;
    if (!ownPeriodic.length && evidence.some(other => {
      const plan = [...own.plans][0];
      if (other.group === group || other.group.subject !== group.subject || other.first >= own.first
        || own.plans.size !== 1 || !other.plans.has(plan!)) return false;
      // The other clock's readings of this plan before and after this one's first, each instant parsed once.
      let before = 0, beforePeak = own.peak, lastTime = NaN;
      const after: number[] = [];
      other.ordered.forEach((p, index) => {
        if (p.plan !== plan) return;
        const time = other.times[index]!;
        lastTime = time;
        if (time <= own.first) { before++; beforePeak = Math.max(beforePeak, p.used_percent); }
        else if (time > own.first) after.push(p.used_percent);
      });
      return before > 0 && lastTime + 120000 >= own.last && after.some(percent => percent > beforePeak);
    })) {
      conflictingReadings += group.probes.length;
      return [];
    }
    const anchors = new Map<string, number>();
    const plans = new Set(group.probes.map(p => p.plan).filter(p => p !== null));
    const confirmedPlans = new Set(ownPeriodic.map(p => p.plan).filter(p => p !== null));
    for (const p of group.probes) anchors.set(p.resets_at!, (anchors.get(p.resets_at!) ?? 0) + 1);
    const reset = [...anchors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const start = Date.parse(reset) - duration;
    const unique = new Map<string, CodexProbe>();
    for (const p of group.probes) {
      if (p.kind === "session" && p.plan && confirmedPlans.size === 1 && !confirmedPlans.has(p.plan)) { conflictingReadings++; continue; }
      if (Date.parse(p.ts) < start || Date.parse(p.ts) >= Date.parse(reset)) continue;
      const plan = p.plan ?? (plans.size === 1 ? [...plans][0]! : null);
      const row = { ...p, resets_at: reset, plan };
      const key = JSON.stringify([p.ts, p.used_percent, plan]);
      if (!unique.has(key)) unique.set(key, row);
    }
    const ordered = sortByInstant([...unique.values()], p => p.ts);
    if (!group.probes.some(p => p.kind === "session")) return ordered;
    // Reconcile isolated session spikes before taking cumulative maxima. Otherwise
    // one false 100% discards every later observation and freezes capacity forever.
    const reconciled = ordered.filter((p,index) => {
      if (p.kind !== "session" || p.used_percent !== 100 || !p.plan) return true;
      const before = ordered[index-1], first = ordered[index+1];
      // Polls may repeat the same rounded percentage before the next increase.
      const second = first && ordered.slice(index+2).find(row => row.plan !== first.plan || row.used_percent !== first.used_percent);
      if (!before || !first || !second || [before,first,second].some(row => row.plan !== p.plan)) return true;
      const contradicted = p.used_percent > before.used_percent+1
        && first.used_percent < p.used_percent-1 && second.used_percent < p.used_percent-1
        && first.used_percent > 0 && first.used_percent >= before.used_percent && second.used_percent > before.used_percent
        && second.used_percent >= first.used_percent
        && Date.parse(before.ts) < Date.parse(p.ts) && Date.parse(p.ts) < Date.parse(first.ts)
        && Date.parse(first.ts) < Date.parse(second.ts);
      if (!contradicted) return true;
      conflictingReadings++;
      return false;
    });
    // Both sources round and can replay old values. Keep the maximum cumulative
    // sample on one clock, never extend its timestamp using a lower cached value.
    if (options.preserveDrops) return reconciled;
    const peaks = new Map<string | null, number>();
    return reconciled.filter((p,index) => {
      if (p.used_percent < (peaks.get(p.plan) ?? 0)) {
        // A measured zero followed by growth is a real reset even if its clock stayed unchanged.
        if (p.kind === "session" || p.used_percent !== 0) return false;
        const next = reconciled.slice(index+1).find(row => row.plan === p.plan && row.kind !== "session");
        if (!next || next.used_percent <= 0) return false;
      }
      peaks.set(p.plan, p.used_percent);
      return true;
    });
  };
  const placed = sortByInstant(groups.flatMap(group => output(group).map((probe, index) => ({ probe, group: group.key, index }))), item => item.probe.ts);
  // Anchors of every reading group, kept or not, and each kept reading's group and place in it:
  // a bounded recomputation proves its lookback with the first and orders equal times with the second.
  return { probes: placed.map(item => item.probe), conflictingReadings, anchors: groups.map(group => group.anchor),
    order: placed.map(({ group, index }) => ({ group, index })) };
}
