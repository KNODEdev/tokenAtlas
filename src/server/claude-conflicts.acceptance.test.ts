import { publishFixtureRules } from "../projects/rules.fixture";
import { expect, spyOn, test } from "bun:test";
import { installAnalysisTracking } from "../db/analysis";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { buildProjectCost } from "./project-cost";
import { buildRepoHistory } from "./repo-history";
import { createDataRead } from "./data-read";
import { buildEraIndex } from "./eras";
import type { AppContext } from "./api";
import type { Database } from "../db/sqlite";

const RANGE = { since: "2026-09-15", until: "2026-09-16" };
/** The ledger's stored valuations per source row; repricing would change them. */
const valuations = (db: Database) => new Map((db.query(`SELECT row_id,std_key,std_reason,std_nano,std_femto,
  act_key,act_reason,act_nano,act_femto,glb_key,glb_reason,glb_nano,glb_femto FROM usage_ledger_facts WHERE provider='claude'
  ORDER BY row_id`).all() as Array<Record<string, unknown>>).map(row => [row.row_id, JSON.stringify(row)]));
const CONFLICTS = [{ account: ACCOUNTS.a, identities: 1 }];

function fixture(copyTs: string | null = "2026-09-16T00:01:00.000Z") {
  const f = createClaudeCodeAcceptanceFixture();
  f.db.exec("DELETE FROM claude_events; ALTER TABLE claude_events ADD COLUMN repo TEXT; ALTER TABLE claude_events ADD COLUMN repo_group TEXT");
  installAnalysisTracking(f.db);
  let rates = structuredClone(f.rates);
  rates.subscriptions = { [ACCOUNTS.a]: { usd_per_month: 30.44 }, [ACCOUNTS.b]: { usd_per_month: 60.88 } };
  function event(id: string, ts: string, tokens: number, account: string = ACCOUNTS.a,
    project = "alpha", store = "first-copy") {
    const insert = f.db.query(`INSERT INTO claude_events
      (store,call_id,path,ts,model,speed,subscription_id,session_id,project_id,repo,entrypoint,cc_version,in_uncached,out_total)
      VALUES (?,?,'synthetic.jsonl',?,'claude-sonnet-fixture','standard',?,'synthetic-session',?,
        'synthetic-repo','cli','2.1.0',?,?)`);
    insert.run(store, id, ts, account, project, tokens * .8, tokens * .2);
    insert.finalize();
  }
  event("accepted-a", "2026-09-15T00:00:00.000Z", 1000);
  event("conflict-1", "2026-09-15T00:01:00.000Z", 2000);
  if (copyTs) event("conflict-1", copyTs, 9000, ACCOUNTS.a, "beta", "conflicting-copy");
  event("accepted-b", "2026-09-15T01:00:00.000Z", 3000, ACCOUNTS.b);
  f.prepareFacts();
  function read(range: { since?: string; until?: string } = RANGE, project = "alpha") {
    return {
      cost: buildProjectCost(f.db, rates, new Map(), range),
      history: buildRepoHistory(f.db, { ...range, projectId: project, repo: null,
        granularity: "day", by: "account", idleGapMinutes: 15, rateCards: rates, homeToSubId: new Map() }),
    };
  }
  return { f, get rates(){return rates;}, event, read,
    changeRates(next:typeof rates){rates=next;f.prepareFacts(next);} };
}

test("one conflicted identity across days and subjects stays unknown and blocks only its account's fee allocation", () => {
  const { f, read } = fixture();
  try {
    const { cost, history } = read();
    // Only the two uncontested calls count: A=1000, B=3000, cost=.0054+.0162.
    expect(cost.totals).toMatchObject({ tokens: 4000, calls: 2, api_usd: .02, api_complete: false });
    expect(cost.coverage).toMatchObject({ conflicting_usage: {
      vendor: "claude", identities: 1, accounts: CONFLICTS, tokens: null, api_usd: null, billed_usd: null,
    } });
    expect(cost.coverage.totals.tokens).toBe(0);
    expect(cost.coverage.totals.calls).toBe(0);
    expect(cost.subscriptions.find(row => row.id === ACCOUNTS.a)).toMatchObject({ api_complete: false });
    expect(cost.subscriptions.find(row => row.id === ACCOUNTS.b)).toMatchObject({ api_complete: true });
    const alpha = cost.subjects.find(row => row.subject === "p:alpha")!;
    expect(alpha.subscriptions[ACCOUNTS.a]!.billed_usd).toBeNull();
    expect(alpha.subscriptions[ACCOUNTS.b]!.billed_usd).toBe(2);
    expect(alpha.billed_complete).toBe(false);
    expect(history.totals).toMatchObject({ tokens: 4000, calls: 2, api_usd: .02,
      api_complete: false, billed_complete: false });
    expect(history.claude).toMatchObject({ conflicts: CONFLICTS });
    expect(history.totals.by_sub[ACCOUNTS.a]!.billed_usd).toBeNull();
    expect(history.totals.by_sub[ACCOUNTS.b]!.billed_usd).toBe(2);
    expect(history.points[0]!.api_complete).toBe(false);
  } finally { f.teardown(); }
});

test("a project/date filter cannot hide the other conflicting copy or count one identity twice", () => {
  const { f, read } = fixture();
  try {
    for (const day of ["2026-09-15", "2026-09-16"]) {
      const { cost, history } = read({ since: day, until: day }, "alpha");
      expect(cost.coverage).toMatchObject({ conflicting_usage: { identities: 1, accounts: CONFLICTS } });
      expect(history.claude).toMatchObject({ conflicts: CONFLICTS });
      expect(history.totals.api_complete).toBe(false);
    }
    expect(read().cost.coverage).toMatchObject({ conflicting_usage: { identities: 1 } });
    const outside = read({ since: "2026-09-17", until: "2026-09-17" });
    expect(outside.cost.coverage).not.toHaveProperty("conflicting_usage");
    expect(outside.cost.totals).toMatchObject({ tokens: 0, calls: 0, api_complete: true });
    expect(outside.history.totals.api_complete).toBe(true);
  } finally { f.teardown(); }
});

test("identical mirrors remain one accepted call without conflict diagnostics", () => {
  const { f, event, read } = fixture(null);
  try {
    event("conflict-1", "2026-09-15T00:01:00.000Z", 2000, ACCOUNTS.a, "alpha", "equal-copy");
    f.prepareFacts();
    const { cost, history } = read();
    expect(cost.coverage).not.toHaveProperty("conflicting_usage");
    expect(cost.totals).toMatchObject({ tokens: 6000, calls: 3, api_usd: .03, api_complete: true });
    expect(history.totals).toMatchObject({ tokens: 6000, calls: 3, api_usd: .03,
      api_complete: true, billed_usd: 3, billed_complete: true });
  } finally { f.teardown(); }
});

test("unbounded history exposes the same distinct conflict count as its containing date range", () => {
  const { f, read } = fixture();
  try {
    const result = read({});
    expect(result.cost.coverage).toMatchObject({ conflicting_usage: { identities: 1, accounts: CONFLICTS } });
    expect(result.cost.totals).toMatchObject({ tokens: 4000, api_complete: false });
    expect(result.history.claude).toMatchObject({ conflicts: CONFLICTS });
    expect(result.history.totals.api_complete).toBe(false);
  } finally { f.teardown(); }
});

test("a conflict-only account is visible even with no accepted groups or history points", () => {
  const { f, read } = fixture();
  try {
    f.db.exec("DELETE FROM claude_events WHERE call_id IN ('accepted-a','accepted-b')");
    f.prepareFacts();
    const { cost, history } = read();
    expect(cost.totals).toMatchObject({ tokens: 0, calls: 0, api_usd: 0, api_complete: false });
    expect(cost.coverage).toMatchObject({ conflicting_usage: { identities: 1, accounts: CONFLICTS, tokens: null } });
    expect(history.points).toEqual([]);
    expect(history.totals.api_complete).toBe(false);
    expect(history.claude).toMatchObject({ conflicts: CONFLICTS });
    expect(history.notes.join(" ")).toMatch(/conflict|contradict/i);
  } finally { f.teardown(); }
});

test("zero-token conflicting evidence cannot disappear behind a token-sum filter", () => {
  const { f, read } = fixture();
  try {
    f.db.exec("UPDATE claude_events SET in_uncached=0,out_total=0 WHERE call_id='conflict-1' AND store='first-copy'");
    f.prepareFacts();
    const { cost, history } = read();
    expect(cost.coverage).toMatchObject({ conflicting_usage: { identities: 1, accounts: CONFLICTS } });
    expect(cost.totals.tokens).toBe(4000);
    expect(history.claude).toMatchObject({ conflicts: CONFLICTS });
    expect(history.totals.by_sub[ACCOUNTS.a]!.billed_usd).toBeNull();
  } finally { f.teardown(); }
});

test("removing the conflicting copy restores canonical traffic and allocations after restart, matching a fresh reference", () => {
  const live = fixture(), reference = fixture(null);
  try {
    live.read();
    live.f.db.exec("DELETE FROM claude_events WHERE store='conflicting-copy'");
    live.f.prepareFacts();
    live.f.reopen();
    const repaired = live.read();
    expect(repaired).toEqual(reference.read());
    expect(repaired.cost.coverage).not.toHaveProperty("conflicting_usage");
    expect(repaired.cost.totals).toMatchObject({ tokens: 6000, calls: 3, api_complete: true });
    expect(repaired.history.totals).toMatchObject({ billed_usd: 3, billed_complete: true, api_complete: true });
  } finally { live.f.teardown(); reference.f.teardown(); }
});

test("a late conflicting copy outside the selection excludes the old call without repricing accepted traffic", () => {
  const live = fixture(null), reference = fixture("2026-09-19T12:00:00.000Z");
  try {
    expect(live.read().history.totals.calls).toBe(3);
    const priced = valuations(live.f.db);
    live.event("conflict-1", "2026-09-19T12:00:00.000Z", 9000, ACCOUNTS.a, "beta", "conflicting-copy");
    live.f.prepareFacts();
    live.f.reopen();
    const changed = live.read();
    expect(changed).toEqual(reference.read());
    expect(changed.cost.coverage).toMatchObject({ conflicting_usage: { identities: 1 } });
    expect(changed.history.totals.calls).toBe(2);
    // The accepted calls keep their registered valuations.
    const after = valuations(live.f.db);
    for (const [row, value] of priced) expect(after.get(row)).toBe(value);
  } finally { live.f.teardown(); reference.f.teardown(); }
});

test("an unrelated later call does not change conflict counts of a historical selection", () => {
  const { f, event, read } = fixture();
  try {
    const before = read();
    expect(before.cost.coverage).toMatchObject({ conflicting_usage: { identities: 1 } });
    event("unrelated-after-range", "2026-09-25T12:00:00.000Z", 5000);
    f.prepareFacts();
    f.reopen();
    const after = read();
    expect(after.cost.coverage).toEqual(before.cost.coverage);
    expect(after.history.totals).toEqual(before.history.totals);
  } finally { f.teardown(); }
});

test("conflict diagnostics survive share-only changes and reopen without repricing", () => {
  const { f, read } = fixture();
  try {
    const before = read();
    expect(before.history.claude).toMatchObject({ conflicts: CONFLICTS });
    const priced = valuations(f.db);
    f.changeShare(18);
    f.reopen();
    const after = read();
    expect(after.history).toEqual(before.history);
    expect(after.cost.coverage).toEqual(before.cost.coverage);
    expect(valuations(f.db)).toEqual(priced);
  } finally { f.teardown(); }
});

test("a rate change reprices accepted traffic and keeps the independent conflict count", () => {
  const sample=fixture(),{ f, read }=sample;
  try {
    const before = read();
    const nextRates=structuredClone(sample.rates);
    nextRates.vendors.anthropic!.models!["claude-sonnet-fixture"]!.out_total = 30;
    f.reopen();
    sample.changeRates(nextRates);
    const after = read();
    expect(after.cost.coverage.conflicting_usage).toEqual(before.cost.coverage.conflicting_usage);
    expect(after.history.claude?.conflicts).toEqual(CONFLICTS);
    expect(after.cost.totals.api_usd).toBe(.03);
    expect(after.history.totals.api_usd).toBe(.03);
  } finally { f.teardown(); }
});

test("an open-ended range detects a late conflicting copy on a new day", () => {
  const live = fixture(null), reference = fixture("2026-09-19T12:00:00.000Z");
  try {
    const before = live.read({});
    expect(before.history.totals.api_complete).toBe(true);
    live.event("conflict-1", "2026-09-19T12:00:00.000Z", 9000, ACCOUNTS.a, "beta", "conflicting-copy");
    live.f.prepareFacts();
    live.f.reopen();
    const after = live.read({});
    expect(after).toEqual(reference.read({}));
    expect(after.history.claude?.conflicts).toEqual(CONFLICTS);
  } finally { live.f.teardown(); reference.f.teardown(); }
});

test("both HTTP producers report conflict diagnostics, read-only, and the same answer after reopen", async () => {
  const { f, rates } = fixture();
  const ctx = { sqlite: f.db, dbPath: f.dbPath, rateCards: rates, accounts: { version: 2, subscriptions: [], sources: [] },
    homeToSubId: new Map(), subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null,
    claudeGauge: {}, grokGauge: {}, cycles: {}, plans: {}, plansCatalog: { provider_groups: [] },
    rootDir: f.directory, attribution: null } as unknown as AppContext;
  // The analysis worker reads projects.json.
  const restoreRules = publishFixtureRules(f.db);
  const urls = [
    "http://local/api/project-cost?since=2026-09-15&until=2026-09-16",
    "http://local/api/repo-history?project=alpha&since=2026-09-15&until=2026-09-16&granularity=day&by=account",
  ];
  let reader = createDataRead();
  try {
    const published: unknown[] = [];
    const readTimes: number[] = [];
    for (const url of urls) {
      expect((await reader(ctx, new Request(url))).status).toBe(202);
      await reader.whenIdle();
      const before = f.db.query("SELECT total_changes() n").get();
      const readTime = Date.now();
      const response = await reader(ctx, new Request(url));
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("X-Analysis")).toBe("memory");
      expect(f.db.query("SELECT total_changes() n").get()).toEqual(before);
      const payload = await response.json();
      expect(payload.totals).toMatchObject({ tokens: 4000, api_complete: false });
      if (url.includes("/project-cost"))
        expect(payload.coverage).toMatchObject({ conflicting_usage: { identities: 1, accounts: CONFLICTS } });
      else expect(payload.claude).toMatchObject({ conflicts: CONFLICTS });
      published.push(payload);
      readTimes.push(readTime);
    }
    await reader.close();
    ctx.sqlite = f.reopen();
    reader = createDataRead();
    for (const [i, url] of urls.entries()) {
      // A restart keeps no answers: the same rows give the same answer again (project-cost reads the minute clock).
      const clock = spyOn(Date, "now").mockReturnValue(readTimes[i]!);
      try {
        expect((await reader(ctx, new Request(url))).status).toBe(202);
        await reader.whenIdle();
        const response = await reader(ctx, new Request(url));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(published[i]);
      } finally { clock.mockRestore(); }
    }
  } finally { await reader.close(); restoreRules(); f.teardown(); }
}, 30_000);
