import { expect, test } from "bun:test";
import { installAnalysisTracking } from "../db/analysis";
import { BacklogProgress, ProgressRegistry } from "../sync/progress";
import { createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { runBackgroundTurn, type BackgroundTurn } from "./background-jobs";
import { analysisRebuildStatus, queueAnalysisRebuild } from "./analysis-rebuild";

const turnOf = (fixture: ReturnType<typeof createClaudeCodeAcceptanceFixture>, canWrite: () => boolean = () => true): BackgroundTurn => {
  const progress = new ProgressRegistry(null);
  return { db: fixture.db, config: { subscriptions: [], sources: [] }, rates: fixture.rates, journal: null,
    turnMs: 0, canWrite, progress, backlog: new BacklogProgress(progress) };
};
/** The fixture has no Codex source table; an empty one makes the Codex ledger a proven no-op. */
const withEmptyCodexSource = (fixture: ReturnType<typeof createClaudeCodeAcceptanceFixture>) => {
  fixture.db.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT)");
  installAnalysisTracking(fixture.db);
  return fixture;
};
const rows = (fixture: ReturnType<typeof createClaudeCodeAcceptanceFixture>, table: string) =>
  fixture.db.query(`SELECT * FROM "${table}" ORDER BY 1`).all();

test("a failing job is reported by scope while the other jobs of the turn still write", () => {
  const fixture = withEmptyCodexSource(createClaudeCodeAcceptanceFixture());
  try {
    fixture.db.exec(`CREATE TRIGGER fixture_refuse_prices BEFORE INSERT ON usage_ledger_state WHEN NEW.provider='codex'
      BEGIN SELECT RAISE(ABORT, 'refused by fixture'); END`);
    const limitInputs = rows(fixture, "limit_window_inputs");
    const result = runBackgroundTurn(turnOf(fixture));
    expect(Object.keys(result.errors)).toEqual(["usage-prices"]);
    expect(result.errors["usage-prices"]).toContain("refused by fixture");
    // A job before it (the current projection) and one after it (limit windows) still wrote.
    expect((fixture.db.query("SELECT COUNT(*) n FROM current_projection_dirty").get() as { n: number }).n).toBeGreaterThan(0);
    expect(rows(fixture, "limit_window_inputs")).not.toEqual(limitInputs);
  } finally { fixture.teardown(); }
}, 30000);

test("a writer that must yield writes nothing", () => {
  const fixture = withEmptyCodexSource(createClaudeCodeAcceptanceFixture());
  try {
    const changes = () => fixture.db.query("SELECT total_changes() n").get();
    const before = changes();
    const result = runBackgroundTurn(turnOf(fixture, () => false));
    expect(result).toMatchObject({ catchUpNeeded: false, errors: {} });
    expect(changes()).toEqual(before);
  } finally { fixture.teardown(); }
}, 30000);

test("an explicit rebuild completes in the turn its derived registers have caught up", () => {
  const fixture = withEmptyCodexSource(createClaudeCodeAcceptanceFixture());
  try {
    const queued = queueAnalysisRebuild(fixture.db, { scope: "all" }, new Date("2026-09-20T12:00:00Z"));
    let status = analysisRebuildStatus(fixture.db);
    for (let turn = 0; turn < 50 && status?.state !== "complete" && status?.state !== "error"; turn++) {
      runBackgroundTurn(turnOf(fixture));
      status = analysisRebuildStatus(fixture.db);
    }
    expect(status).toMatchObject({ generation: queued.generation, state: "complete", phase: "reports", completed: 3, total: 3 });
  } finally { fixture.teardown(); }
}, 60000);

test("a probe round's readings are fed on the next turn, not shown as queued feed work for a minute", () => {
  const fixture = withEmptyCodexSource(createClaudeCodeAcceptanceFixture());
  try {
    const turn = turnOf(fixture);
    runBackgroundTurn(turn);
    const feed = () => turn.progress.entries().filter(entry => entry.scope === "account-periods");
    expect(feed()).toEqual([]);
    // The next probe round, seconds after the feed's last run (the trial start of 05.10 showed 0/12 each round).
    fixture.db.exec(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,
      vendor_percent,resets_at,window_minutes,ok,extra,machine) SELECT provider,subject,strftime('%Y-%m-%dT%H:%M:%fZ',ts,'+10 minutes'),plan,kind,
      limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine
      FROM probe_windows ORDER BY id DESC LIMIT 1`);
    runBackgroundTurn(turn);
    expect(feed()).toEqual([]);
    const last = fixture.db.query("SELECT MAX(id) id FROM probe_windows").get() as { id: number };
    expect(fixture.db.query("SELECT value FROM meta WHERE key='account_periods_probe_cursor'").get()).toEqual({ value: String(last.id) });
  } finally { fixture.teardown(); }
}, 30000);
