import { expect, test } from "bun:test";
import { unionActivity, type ActivityInterval } from "../db/activity-intervals";
import { activityByDay, intervalSeconds, type ProjectActivity } from "./project-active-time";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { buildRepoHistory, listSubjects } from "./repo-history";
import { publishFixtureRules } from "../projects/rules.fixture";

const HOUR = 3_600_000;
const row = (source: string, intervals: ActivityInterval[]): ProjectActivity =>
  ({ source, intervals, subject: "p:alpha", repo: "repo", vendor: "codex", model: "m", account: "a" });
const total = (rows: ProjectActivity[], machineOf: (s: string | null) => string | null) =>
  [...activityByDay(rows, machineOf).values()].reduce((sum, pcs) => sum + [...pcs.values()].reduce((n, spans) => n + intervalSeconds(spans), 0), 0);

test("parallel agents/providers/profiles merge per PC, while simultaneous PCs retain their own hours", () => {
  const start = Date.parse("2026-10-12"), end = start + 168 * HOUR;
  const rows = [row("codex/profile-a", [[start, end]]), row("claude/profile-b", [[start, end]]), row("codex/pc2", [[start, end]])];
  expect(total(rows, () => "PC1")).toBe(168 * 3600);
  expect(total(rows, source => source === "codex/pc2" ? "PC2" : "pc1")).toBe(336 * 3600);
  for (const pcs of activityByDay(rows, () => "PC1").values()) expect(intervalSeconds(pcs.get("PC1")!)).toBe(24 * 3600);
  expect(total(rows, () => null)).toBe(168 * 3600);
});

test("interval union retains disjoint work and millisecond precision and splits at midnight", () => {
  expect(unionActivity([[50, 75], [0, 20], [10, 30], [30, 40], [5, 15]])).toEqual([[0, 40], [50, 75]]);
  const start = Date.parse("2026-10-11T23:59:59.667Z");
  const days = activityByDay([row("pc", [[start, start + 999]])], () => "PC");
  expect(intervalSeconds(days.get("2026-10-11")!.get("PC")!)).toBe(.333);
  expect(intervalSeconds(days.get("2026-10-12")!.get("PC")!)).toBe(.666);
});

test("production history and ranking count a continuous week once per PC, preserve bills, and read stored rows after reopen", () => {
  const f = createClaudeCodeAcceptanceFixture();
  let restoreRules: (() => void) | undefined;
  try {
    f.db.exec("DELETE FROM claude_events");
    const insert = f.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,subscription_id,session_id,project_id,in_uncached,out_total)
      VALUES('primary',?,'synthetic.jsonl',?,'claude-sonnet-fixture','standard',?,?,'alpha',1000,100)`);
    const start = Date.parse("2026-10-12T00:00:00Z");
    f.db.transaction(() => {
      for (let step = 0; step <= 7 * 24 * 4; step++) for (const [account, session] of [[ACCOUNTS.a, "a1"], [ACCOUNTS.a, "a2"], [ACCOUNTS.b, "b1"]])
        insert.run(`${session}-${step}`, new Date(start + step * 15 * 60_000).toISOString(), account!, session!);
    }).immediate();
    f.prepareFacts();
    restoreRules = publishFixtureRules(f.db);
    const range = { since: "2026-10-12", until: "2026-10-18" };
    const options = { repo: null, projectId: "alpha", ...range, granularity: "week" as const, by: "none" as const,
      idleGapMinutes: 15, rateCards: f.rates, homeToSubId: new Map<string, string>(), machineOf: () => "PC1" };
    const valuations = f.db.query("SELECT row_id,std_nano,act_nano,glb_nano FROM usage_ledger_facts ORDER BY provider,row_id").all();
    const single = buildRepoHistory(f.db, options);
    expect(single.points[0]!.active_by_machine).toEqual({ PC1: 168 * 3600 });
    expect(single.totals.active_seconds).toBe(168 * 3600);
    const twoPC = { ...options, machineOf: (source: string | null) => source?.endsWith(ACCOUNTS.b) ? "PC2" : "PC1" };
    const parallel = buildRepoHistory(f.db, twoPC);
    expect(parallel.totals.active_seconds).toBe(336 * 3600);
    expect(parallel.totals.active_by_machine).toEqual({ PC1: 168 * 3600, PC2: 168 * 3600 });
    expect(parallel.totals.api_usd).toBe(single.totals.api_usd);
    expect(parallel.totals.billed_usd).toBe(single.totals.billed_usd);
    expect(parallel.totals.tokens).toBe(single.totals.tokens);
    const day = buildRepoHistory(f.db, { ...options, granularity: "day" });
    expect(day.points.map(p => p.active_seconds)).toEqual(Array(7).fill(24 * 3600));
    expect(buildRepoHistory(f.db, { ...options, granularity: "month" }).totals).toEqual(single.totals);
    const subjects = listSubjects(f.db, 15, range, { rateCards: f.rates, machineOf: options.machineOf });
    expect(subjects.find(s => s.id === "alpha")).toMatchObject({ active_seconds: single.totals.active_seconds, session_seconds: 3 * 168 * 3600 - 3 * 900 });
    f.reopen();
    const before = f.db.query("SELECT total_changes() n").get();
    const statements: string[] = [], query = f.db.query;
    f.db.query = function (this: typeof f.db, sql: string) {
      const statement = query.call(this, sql);
      if (!/\b(?:FROM|JOIN)\s+(?:usage_ledger_facts|codex_price_ledger_events|claude_events)\b/i.test(sql)) return statement;
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? (...args: unknown[]) => {
          if (["all", "get", "iterate"].includes(String(key))) statements.push(sql);
          return Reflect.apply(value, target, args);
        } : value;
      } });
    } as typeof f.db.query;
    try { expect(buildRepoHistory(f.db, options)).toEqual(single); } finally { f.db.query = query; }
    expect(statements).toEqual([]);
    expect(f.db.query("SELECT total_changes() n").get()).toEqual(before);
    expect(f.db.query("SELECT row_id,std_nano,act_nano,glb_nano FROM usage_ledger_facts ORDER BY provider,row_id").all()).toEqual(valuations);
  } finally { restoreRules?.(); f.teardown(); }
}, 30_000);
