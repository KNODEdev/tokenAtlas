import { expect, test } from "bun:test";
import { installAnalysisTracking } from "../db/analysis";
import { BacklogProgress, ProgressRegistry } from "../sync/progress";
import { createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { runBackgroundTurn, type BackgroundTurn } from "./background-jobs";
import { analysisRebuildStatus, queueAnalysisRebuild } from "./analysis-rebuild";
import { installFirstTokenTracking } from "../db/first-token";
import { codexFirstTokenAdapter } from "../providers/first-token/codex";
import { writeRebuildStatusJson } from "../db/rebuild-status";

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

test("a native completion publishes only TTFT and respects a source rebuild and the writer gate", () => {
  const fixture = withEmptyCodexSource(createClaudeCodeAcceptanceFixture());
  try {
    const { db } = fixture;
    db.exec("CREATE TABLE IF NOT EXISTS files(home TEXT,path TEXT,size INTEGER,mtime REAL,PRIMARY KEY(home,path))");
    installFirstTokenTracking(db, codexFirstTokenAdapter);
    db.exec("ALTER TABLE codex_file_evidence ADD COLUMN first_token_json TEXT");
    db.query("INSERT INTO files VALUES('h','/archive/codex/pc/f',1,1)").run();
    db.query(`INSERT INTO codex_file_evidence(home,path,source_sha256,source_byte_length,parser_version,evidence_version,session_headers_json,first_token_json)
      VALUES('h','/archive/codex/pc/f','fixture',1,8,1,'[]',?)`)
      .run(JSON.stringify({ version: 1, turns: [], bookmark: { size: 1, mtime: 1 } }));
    const turn = { ...turnOf(fixture), firstTokenOnly: true };
    const unrelated = rows(fixture, "current_projection_dirty");
    const changes = db.query("SELECT total_changes() n").get();
    runBackgroundTurn({ ...turn, canWrite: () => false });
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    queueAnalysisRebuild(db, { scope: "all" }, new Date("2026-09-20T12:00:00Z"));
    writeRebuildStatusJson(db, JSON.stringify({ ...analysisRebuildStatus(db), phase: "sources" }));
    runBackgroundTurn(turn);
    expect(db.query("SELECT COUNT(*) n FROM response_time_queue").get()).toEqual({ n: 1 });
    // Source ownership stays with the explicit rebuild until its source phase finishes.
    writeRebuildStatusJson(db, JSON.stringify({ ...analysisRebuildStatus(db), phase: "reports" }));
    const result = runBackgroundTurn(turn);
    expect(result.errors).toEqual({});
    expect(db.query("SELECT COUNT(*) n FROM response_time_queue").get()).toEqual({ n: 0 });
    expect(rows(fixture, "current_projection_dirty")).toEqual(unrelated);
    expect(turn.progress.entries()).toEqual([]);
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
