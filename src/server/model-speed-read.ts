import type { Database } from "../db/sqlite";
import { hasModelSpeedSchema, type ModelSpeedFact } from "../db/model-speed-register";
import { TIMED_SUMS, type TimedSums } from "../db/usage-ledger";
import type { AccountResolver } from "./account-resolver";
import { codexEventOwner } from "./codex-event-owner";
import { codexExecution, recordedEffort, type ModelExecution } from "../shared/model-execution";

type Hour = Omit<ModelSpeedFact, "event_id" | "ts">;
export function readModeSpeedHours(db: Database, resolver: AccountResolver, provider: string, account: string,
  options: { since?: string; until?: string; classify?: (tier: string | null, day: string) => string | null } = {}) {
  const result: Array<{ hour: number; model: string | null; calls: number } & ModelExecution & TimedSums> = [];
  if (!hasModelSpeedSchema(db)) return { hours: result, pending: true };
  const pending = !db.query("SELECT 1 FROM model_speed_state WHERE provider=?").get(provider)
    || !!db.query("SELECT 1 FROM model_speed_queue WHERE provider=? LIMIT 1").get(provider);
  const terms = ["provider=?"], args: Array<string | number> = [provider];
  if (options.since) { terms.push("hour>=?"); args.push(Date.parse(`${options.since}T00:00:00Z`) / 3_600_000); }
  if (options.until) { terms.push("hour<?"); args.push(Date.parse(`${options.until}T00:00:00Z`) / 3_600_000 + 24); }
  const plan = resolver.plan(provider, account.replace(/::business$/, ""));
  const ranges = provider === "codex" ? resolver.accounts(provider).flatMap(a => resolver.plan(provider, a).ranges) : plan.ranges;
  const owns = (row: Hour, ts: string) => provider === "codex"
    ? codexEventOwner(resolver.resolve(provider, row.source, null, ts).account, { billing_mode: row.billing })?.toLowerCase() === account.toLowerCase()
    : plan.owns(row.source, row.identity, ts);
  const emit = (row: Hour, sums: { calls: number } & TimedSums) => {
    if (!sums.calls) return;
    const day = new Date(row.hour * 3_600_000).toISOString().slice(0, 10);
    const execution = provider === "codex" ? codexExecution(row.service_tier, row.effort,
      options.classify ? tier => options.classify!(tier, day) : undefined)
      : { speed: row.speed ?? "unknown", effort: recordedEffort(row.effort) };
    result.push({ hour: row.hour, model: row.model, ...execution, ...sums });
  };
  const sumSql = ["calls", ...TIMED_SUMS].map(c => `COALESCE(SUM(${c}),0) ${c}`).join(",");
  for (const row of db.query(`SELECT * FROM model_speed_hours WHERE ${terms.join(" AND ")}`).all(...args) as Hour[]) {
    const start = row.hour * 3_600_000, end = start + 3_600_000;
    const cuts = [...new Set(ranges.filter(r => r.source === row.source?.toLowerCase())
      .flatMap(r => [r.from, r.until]).filter(at => at > start && at < end))].sort((a, b) => a - b);
    if (!cuts.length) { if (owns(row, new Date(start).toISOString())) emit(row, row); continue; }
    const edges = [start, ...cuts, end];
    for (let i = 0; i < edges.length - 1; i++) {
      const from = new Date(edges[i]!).toISOString(), until = new Date(edges[i + 1]!).toISOString();
      if (owns(row, from)) emit(row, db.query(`SELECT ${sumSql} FROM model_speed_facts
        WHERE provider=? AND key=? AND hour=? AND ts>=? AND ts<?`).get(provider, row.key, row.hour, from, until) as { calls: number } & TimedSums);
    }
  }
  return { hours: result, pending };
}
