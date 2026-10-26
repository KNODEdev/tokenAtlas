import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, recordPeriodReading } from "../db/period-store";
import { applyPeriodEdit, buildAccountPeriodsView, planTier, previewPeriodEdit, PERIOD_REVISION_MISMATCH, type AccountPeriodsContext } from "./account-periods-view";
import { loadPlansCatalog } from "./plans-catalog";
import { applyPeriodDeclarations } from "./period-declarations";
import type { AccountDeclarationInput, PeriodEdit } from "../shared/account-periods";
import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import type { RateCard } from "./pricing";

// The ledgers name a call's folder under the archive root their producer reads with.
const ARCHIVE = ARCHIVE_LOGICAL_ROOT.replace(/\\/g, "/");
const CARD = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../rate-cards.json"), "utf8")) as RateCard;
let callId = 0;

/** Recorded calls of one file: `calls` events between `first` and `last` (Claude keeps its file in `path`, Codex its home in `store`). */
function recorded(db: Database, row: { vendor: string; store: string; path: string; day: string; calls: number; first: string; last: string }): void {
  const times = Array.from({ length: row.calls }, (_, index) => index === row.calls - 1 ? row.last : row.first);
  if (row.vendor === "codex") {
    db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT,
      model TEXT, effort TEXT, project TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
      reasoning_out INTEGER, cwd TEXT, project_id TEXT)`);
    for (const ts of times) db.query("INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES (?,?,?,'gpt-5',1,0,0,1)")
      .run(row.store, `${row.store}/${row.path}`, ts);
    return;
  }
  for (const ts of times) db.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached,out_total) VALUES (?,?,?,?,1,1)")
    .run(row.store, `call-${++callId}`, row.path, ts);
  db.query("INSERT OR IGNORE INTO claude_files(store,path,size,mtime,calls,ingested_at) VALUES (?,?,0,0,0,'2026-09-01T00:00:00Z')").run(row.store, row.path);
}
/** The maintenance worker's part: the ledgers follow the recorded calls. */
const prepare = (ctx: AccountPeriodsContext) => prepareUsageRegisters(ctx.sqlite, CARD);

/** One temporary archive: a database, an `accounts.json` and a place for the declarations file. */
function workspace(): AccountPeriodsContext & { dir: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-periods-view-"));
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  const accountsFile = path.join(dir, "accounts.json");
  fs.writeFileSync(accountsFile, JSON.stringify(splitProbeReaderFixtureConfig([
    { id: "claude-sm", vendor: "claude", machine: "EXAMPLE-MAIN", home: `${ARCHIVE}/claude/EXAMPLE-MAIN`, source_home: "C:/Users/sample_a/.claude", account: "account_0006@example.test" },
    { id: "claude-kn", vendor: "claude", account: "account_0002@example.test" },
    { id: "codex3", vendor: "codex", machine: "EXAMPLE-MAIN", home: `${ARCHIVE}/codex/EXAMPLE-MAIN-sample_b`, source_home: "C:/Users/sample_a/.codex-2", account: "hello@k-node.eu" },
    { id: "codex1::business", vendor: "codex", home: "", account: "hello@k-node.eu" },
  ])));
  return {
    dir, sqlite: db, accountsFile, archiveRoot: ARCHIVE, declarationsFile: path.join(dir, "account-periods.json"),
    close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const writeDeclarations = (ctx: AccountPeriodsContext, rows: unknown[], plans: unknown[] = []): void =>
  fs.writeFileSync(ctx.declarationsFile!, JSON.stringify({ version: 1, accounts: rows, plans }, null, 2) + "\n");

test("the view lists observed and declared rows with their ids, notes and declarations file state", () => {
  const ctx = workspace();
  try {
    recordPeriodReading(ctx.sqlite, ACCOUNT_PERIODS, { provider: "claude", subject: "claude/example-main", ts: "2026-09-09T15:48:11.251Z", value: "claude-sm" });
    recordPeriodReading(ctx.sqlite, PLAN_PERIODS, { provider: "claude", subject: "claude-sm", ts: "2026-09-21T19:41:00.000Z", value: "default_claude_max_5x" });
    expect(buildAccountPeriodsView(ctx).declarations).toEqual({ file: ctx.declarationsFile!, present: false, errors: [] });
    expect(buildAccountPeriodsView(ctx).revision).toBe("absent");

    writeDeclarations(ctx,
      [{ provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-01-01", until: "2026-03-29", evidence: "owner-declaration", note: "potwierdzenia płatności" }],
      [{ provider: "claude", account: "claude-kn", plan: "max-20x", from: "2026-02-28", until: "2026-03-28", amount_minor: 10181, currency: "EUR", evidence: "payment-confirmation" }]);
    const applied = applyPeriodEdit(ctx, { revision: buildAccountPeriodsView(ctx).revision, kind: "account",
      row: { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-04-01", until: null, evidence: "owner-declaration" } });
    expect(applied.applied).toBe(true);

    const view = applied.view;
    expect(view.declarations.present).toBe(true);
    expect(view.declarations.errors).toEqual([]);
    expect(view.accountPeriods.map((r) => [r.origin, r.source, r.account, r.from, r.until, r.note])).toEqual([
      // A folder declared in capitals joins the source key, so the card draws one lane for it.
      ["declared", "claude/example-main", "claude-kn", "2026-01-01", "2026-03-29", "potwierdzenia płatności"],
      ["declared", "claude/example-main", "claude-kn", "2026-04-01", null, null],
      ["observed", "claude/example-main", "claude-sm", "2026-09-09T15:48:11.251Z", null, null],
    ]);
    expect(view.accountPeriods.every((r) => r.id > 0)).toBe(true);
    expect(view.planPeriods.map((r) => [r.origin, r.account, r.plan, r.amountMinor, r.currency])).toEqual([
      ["declared", "claude-kn", "max-20x", 10181, "EUR"],
      ["observed", "claude-sm", "default_claude_max_5x", null, null],
    ]);
    // Accounts come from the period tables and from `accounts.json`; a billing variant is not an account.
    expect(view.accounts).toEqual([
      { provider: "claude", id: "claude-kn", label: "account_0002@example.test", current: false },
      { provider: "claude", id: "claude-sm", label: "account_0006@example.test", current: false },
      { provider: "codex", id: "codex3", label: "hello@k-node.eu", current: false },
    ]);
  } finally { ctx.close(); }
});

test("sources come from periods, recorded calls and declarations, with their computer, profile and recorded events", () => {
  const ctx = workspace();
  try {
    recordPeriodReading(ctx.sqlite, ACCOUNT_PERIODS, { provider: "claude", subject: "claude/example-laptop-a", ts: "2026-09-11T09:52:10.405Z", value: "claude-sm" });
    recorded(ctx.sqlite, { vendor: "claude", store: "live", path: `${ARCHIVE}/claude/EXAMPLE-MAIN/H---Dev/a.jsonl`, day: "2026-07-20", calls: 4, first: "2026-07-20T08:00:00Z", last: "2026-07-20T09:00:00Z" });
    recorded(ctx.sqlite, { vendor: "anthropic", store: "live", path: `${ARCHIVE}/claude/EXAMPLE-MAIN/H---Dev/b.jsonl`, day: "2026-07-22", calls: 6, first: "2026-07-22T08:00:00Z", last: "2026-07-22T10:00:00Z" });
    recorded(ctx.sqlite, { vendor: "claude", store: "desktop", path: `${ARCHIVE}/claude/EXAMPLE-MAIN-desktop/c.jsonl`, day: "2026-06-25", calls: 2, first: "2026-06-25T08:00:00Z", last: "2026-06-25T08:30:00Z" });
    recorded(ctx.sqlite, { vendor: "codex", store: `${ARCHIVE}/codex/EXAMPLE-MAIN-sample_a`, path: "rollout-1.jsonl", day: "2026-08-01", calls: 9, first: "2026-08-01T07:00:00Z", last: "2026-08-01T11:00:00Z" });
    // A live local mirror is outside the archive and names no source.
    recorded(ctx.sqlite, { vendor: "codex", store: "C:/Users/sample_a/.codex", path: "rollout-2.jsonl", day: "2026-08-02", calls: 99, first: "2026-08-02T07:00:00Z", last: "2026-08-02T11:00:00Z" });
    prepare(ctx);

    const sources = buildAccountPeriodsView(ctx).sources;
    expect(sources.map((s) => [s.provider, s.key, s.machine, s.profile, s.events])).toEqual([
      ["claude", "claude/example-laptop-a", "example-laptop-a", ".claude", null],
      ["claude", "claude/example-main", "EXAMPLE-MAIN", ".claude", { first: "2026-07-20T08:00:00.000Z", last: "2026-07-22T10:00:00.000Z", calls: 10 }],
      ["claude", "claude/example-main-desktop", "EXAMPLE-MAIN", null, { first: "2026-06-25T08:00:00.000Z", last: "2026-06-25T08:30:00.000Z", calls: 2 }],
      ["codex", "codex/example-main-sample_b", "EXAMPLE-MAIN", ".codex-2", null],
      ["codex", "codex/example-main-sample_a", "EXAMPLE-MAIN", ".codex", { first: "2026-08-01T07:00:00Z", last: "2026-08-01T11:00:00Z", calls: 9 }],
    ]);
  } finally { ctx.close(); }
});

test("an edit appends, replaces and removes one declared row and the tables follow", () => {
  const ctx = workspace();
  try {
    const revision = () => buildAccountPeriodsView(ctx).revision;
    const rows = () => loadPeriods(ctx.sqlite, ACCOUNT_PERIODS).map((p) => [p.origin, p.value, p.from, p.until, p.evidence]);

    // An absent file: the first edit creates it.
    expect(revision()).toBe("absent");
    const first = applyPeriodEdit(ctx, { revision: "absent", kind: "account",
      row: { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-01-01", until: "2026-03-29", evidence: "owner-declaration", note: "  " } });
    expect(first.applied).toBe(true);
    expect(fs.existsSync(ctx.declarationsFile!)).toBe(true);
    expect(first.view.revision).not.toBe("absent");
    expect(rows()).toEqual([["declared", "claude-kn", "2026-01-01", "2026-03-29", "owner-declaration"]]);
    // An empty note is not written at all.
    expect(JSON.parse(fs.readFileSync(ctx.declarationsFile!, "utf8")).accounts[0]).toEqual({
      provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-01-01", until: "2026-03-29", evidence: "owner-declaration" });

    // A second row, then a correction of the first one, addressed by source and start.
    applyPeriodEdit(ctx, { revision: revision(), kind: "account",
      row: { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-sm", from: "2026-07-29T09:54:00Z", until: "", evidence: "config-copies" } });
    const corrected = applyPeriodEdit(ctx, { revision: revision(), kind: "account", replace: { source: "claude/example-main", from: "2026-01-01" },
      row: { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-01-01", until: "2026-03-30", evidence: "payment-confirmation" } });
    expect(corrected.applied).toBe(true);
    expect(rows()).toEqual([
      ["declared", "claude-kn", "2026-01-01", "2026-03-30", "payment-confirmation"],
      ["declared", "claude-sm", "2026-07-29T09:54:00Z", null, "config-copies"],
    ]);

    // Removing the corrected row leaves the other one exactly where the owner put it.
    const removed = applyPeriodEdit(ctx, { revision: revision(), kind: "account", replace: { source: "claude/EXAMPLE-MAIN", from: "2026-01-01" }, row: null });
    expect(removed.applied).toBe(true);
    expect(rows()).toEqual([["declared", "claude-sm", "2026-07-29T09:54:00Z", null, "config-copies"]]);

    // Plans travel the same road.
    applyPeriodEdit(ctx, { revision: revision(), kind: "plan",
      row: { provider: "claude", account: "claude-kn", plan: "max-5x", from: "2026-04-08", until: "2026-05-08", evidence: "payment-confirmation", amount_minor: 9000, currency: "EUR" } });
    expect(loadPeriods(ctx.sqlite, PLAN_PERIODS).map((p) => [p.value, p.amountMinor, p.currency])).toEqual([["max-5x", 9000, "EUR"]]);
  } finally { ctx.close(); }
});

test("a stale revision, an overlapping row and an unknown key are refused and leave the file untouched", () => {
  const ctx = workspace();
  try {
    writeDeclarations(ctx, [{ provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-01-01", until: "2026-03-29", evidence: "owner-declaration" }]);
    const before = fs.readFileSync(ctx.declarationsFile!, "utf8"), revision = buildAccountPeriodsView(ctx).revision;
    const append = (row: AccountDeclarationInput): PeriodEdit => ({ revision, kind: "account", row });
    const row = (patch: Partial<AccountDeclarationInput>): AccountDeclarationInput =>
      ({ provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-sm", from: "2026-05-01", until: null, evidence: "owner-declaration", ...patch });

    expect(() => applyPeriodEdit(ctx, { ...append(row({})), revision: "stale" })).toThrow(PERIOD_REVISION_MISMATCH);
    // An overlap with another declared row of the same source, whatever its spelling.
    expect(() => applyPeriodEdit(ctx, append(row({ source: "claude/example-main", from: "2026-02-01", until: "2026-05-01" })))).toThrow(/nakładające się okresy/);
    // A specific message before the file-wide validation gets a chance.
    expect(() => applyPeriodEdit(ctx, append(row({ account: "" })))).toThrow("Uzupełnij pola: account.");
    expect(() => applyPeriodEdit(ctx, append(row({ from: "wczoraj" })))).toThrow("Nieprawidłowa data początku: 'wczoraj'.");
    expect(() => applyPeriodEdit(ctx, append(row({ until: "2026-05-01" })))).toThrow("Koniec okresu musi być późniejszy niż początek.");
    expect(() => applyPeriodEdit(ctx, { revision, kind: "account", replace: { source: "claude/OTHER", from: "2026-01-01" }, row: null }))
      .toThrow(/Nie ma zadeklarowanego wiersza/);

    expect(fs.readFileSync(ctx.declarationsFile!, "utf8")).toBe(before);
    expect(loadPeriods(ctx.sqlite, ACCOUNT_PERIODS)).toEqual([]);
  } finally { ctx.close(); }
});

test("a preview counts the events of the source in range and lists the observed rows it would override", () => {
  const ctx = workspace();
  try {
    recordPeriodReading(ctx.sqlite, ACCOUNT_PERIODS, { provider: "claude", subject: "claude/example-main", ts: "2026-09-09T15:48:11.251Z", value: "claude-sm" });
    for (const day of ["2026-07-19", "2026-07-20", "2026-07-22", "2026-07-29", "2026-08-01"]) {
      recorded(ctx.sqlite, { vendor: "claude", store: "live", path: `${ARCHIVE}/claude/EXAMPLE-MAIN/H---Dev/${day}.jsonl`, day, calls: 3, first: `${day}T08:00:00Z`, last: `${day}T09:00:00Z` });
    }
    recorded(ctx.sqlite, { vendor: "claude", store: "live", path: `${ARCHIVE}/claude/EXAMPLE-LAPTOP-A/H---Dev/x.jsonl`, day: "2026-07-21", calls: 50, first: "2026-07-21T08:00:00Z", last: "2026-07-21T09:00:00Z" });
    prepare(ctx);

    // `until` at midnight stops the day before; the other source's day is not counted.
    const midnight = previewPeriodEdit(ctx, { revision: "absent", kind: "account", preview: true,
      row: { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-07-20", until: "2026-07-29", evidence: "x" } });
    expect(midnight.events).toEqual({ calls: 6, days: 2, first: "2026-07-20T08:00:00.000Z", last: "2026-07-22T09:00:00.000Z" });
    expect(midnight.errors).toEqual([]);

    // `until` with a time of day still counts its own day.
    const afternoon = previewPeriodEdit(ctx, { revision: "absent", kind: "account", preview: true,
      row: { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-07-20", until: "2026-07-29T09:54:00Z", evidence: "x" } });
    expect(afternoon.events).toEqual({ calls: 9, days: 3, first: "2026-07-20T08:00:00.000Z", last: "2026-07-29T09:00:00.000Z" });

    // An open row reaches into the observed period and disagrees with it.
    const open = previewPeriodEdit(ctx, { revision: "absent", kind: "account", preview: true,
      row: { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "claude-kn", from: "2026-07-20", until: null, evidence: "x" } });
    expect(open.overrides).toEqual([{ id: 1, from: "2026-09-09T15:48:11.251Z", until: null, value: "claude-sm" }]);
    expect(midnight.overrides).toEqual([]);
    // A preview writes nothing.
    expect(fs.existsSync(ctx.declarationsFile!)).toBe(false);

    // A plan edit has no events of its own.
    expect(previewPeriodEdit(ctx, { revision: "absent", kind: "plan", preview: true,
      row: { provider: "claude", account: "claude-kn", plan: "max-5x", from: "2026-04-08", until: null, evidence: "x" } }).events).toBeNull();
  } finally { ctx.close(); }
});

test("plan rows carry the catalog name and multiplier, in either spelling of the plan", () => {
  // The repository catalog is the one capacity reads; Claude Pro is the ×1 unit it leaves unset.
  const catalog = loadPlansCatalog(path.resolve(import.meta.dir, "../.."));
  expect(planTier(catalog, "claude", "max-5x", "2026-09-12")).toEqual({ label: "Max 5x", multiplier: 5 });
  expect(planTier(catalog, "claude", "default_claude_max_20x", "2026-09-24T09:50:00.000Z")).toEqual({ label: "Max 20x", multiplier: 20 });
  expect(planTier(catalog, "claude", "pro", "2026-09-09")).toEqual({ label: "Pro", multiplier: 1 });
  expect(planTier(catalog, "codex", "plus", "2026-09-09")?.multiplier).toBe(1);
  expect(planTier(catalog, "codex", "pro", "2026-09-09")?.multiplier).toBe(20);
  expect(planTier(catalog, "claude", "enterprise-seat", "2026-09-09")).toBeNull();
  expect(planTier(undefined, "claude", "max-5x", "2026-09-12")).toBeNull();
  // "No subscription" has no tier at all: it never borrows a catalog plan's multiplier.
  for (const provider of ["claude", "codex", "grok"]) expect(planTier(catalog, provider, "none", "2026-06-20")).toBeNull();
});

test("while the tables lag behind the file the view shows the file's rows, so an edit finds what it names", () => {
  const ctx = workspace();
  try {
    // The tables hold 15.09; a save that could not reach them has already moved the file to 12.09.
    const plan = (from: string) => ({ provider: "claude", account: "claude-sm", plan: "max-5x", from, until: "2026-10-12", evidence: "card-statement" });
    writeDeclarations(ctx, [], [plan("2026-09-15T12:00:00Z")]);
    applyPeriodEdit(ctx, { revision: buildAccountPeriodsView(ctx).revision, kind: "plan", replace: { account: "claude-sm", from: "2026-09-15T12:00:00Z" },
      row: plan("2026-09-15T12:00:00Z") });
    expect(loadPeriods(ctx.sqlite, PLAN_PERIODS).map((p) => p.from)).toEqual(["2026-09-15T12:00:00Z"]);
    writeDeclarations(ctx, [], [plan("2026-09-12T01:00:00Z")]);

    const view = buildAccountPeriodsView(ctx);
    const declared = view.planPeriods.filter((row) => row.origin === "declared");
    expect(declared.map((row) => [row.from, row.id < 0])).toEqual([["2026-09-12T01:00:00Z", true]]);
    const saved = applyPeriodEdit(ctx, { revision: view.revision, kind: "plan", replace: { account: "claude-sm", from: declared[0]!.from },
      row: { ...plan("2026-09-12"), until: "2026-09-24T09:50:00Z" } });
    expect(saved.view.planPeriods.filter((row) => row.origin === "declared").map((row) => [row.from, row.until]))
      .toEqual([["2026-09-12", "2026-09-24T09:50:00Z"]]);
  } finally { ctx.close(); }
});

test("a new plan can end the earlier plan it runs into in the same save, never one that starts inside it", () => {
  const ctx = workspace();
  try {
    const five = { provider: "claude", account: "claude-sm", plan: "max-5x", from: "2026-09-12", until: "2026-10-12", evidence: "card-statement" };
    writeDeclarations(ctx, [], [five]);
    const twenty = { provider: "claude", account: "claude-sm", plan: "max-20x", from: "2026-09-24T09:50:00Z", until: null, evidence: "probe-readings" };
    const edit = { revision: buildAccountPeriodsView(ctx).revision, kind: "plan" as const, replace: null, row: twenty };

    const refused = previewPeriodEdit(ctx, edit);
    expect(refused.errors.length).toBeGreaterThan(0);
    expect(refused.endEarlier).toEqual({ rows: [{ value: "max-5x", from: "2026-09-12", until: "2026-10-12" }], errors: [] });
    expect(() => applyPeriodEdit(ctx, edit)).toThrow();

    applyPeriodEdit(ctx, { ...edit, end_earlier: true });
    expect(JSON.parse(fs.readFileSync(ctx.declarationsFile!, "utf8")).plans.map((p: { plan: string; from: string; until: string | null }) => [p.plan, p.from, p.until]))
      .toEqual([["max-5x", "2026-09-12", "2026-09-24T09:50:00Z"], ["max-20x", "2026-09-24T09:50:00Z", null]]);

    // A plan declared inside the new range is not the earlier one: it stays, and the overlap stays refused.
    const pro = { provider: "claude", account: "claude-sm", plan: "pro", from: "2026-10-01", until: "2026-10-05", evidence: "card-statement" };
    const inside = { revision: buildAccountPeriodsView(ctx).revision, kind: "plan" as const, replace: null, row: pro };
    applyPeriodEdit(ctx, { ...inside, end_earlier: true, row: { ...pro, from: "2026-08-01", until: "2026-08-05" } });
    const late = previewPeriodEdit(ctx, { ...inside, revision: buildAccountPeriodsView(ctx).revision,
      row: { ...twenty, plan: "max-5x", from: "2026-07-01T00:00:00Z", until: "2026-09-01" } });
    expect(late.endEarlier).toBeNull();
    expect(late.errors.length).toBeGreaterThan(0);
  } finally { ctx.close(); }
});

test("the plan editor saves the reserved \"none\" in its one spelling and refuses a payment on it", () => {
  const ctx = workspace();
  try {
    const none = { provider: "claude", account: "claude-sm", plan: " None ", from: "2026-06-18", until: "2026-07-01", evidence: "refund", currency: "EUR" };
    const saved = applyPeriodEdit(ctx, { revision: buildAccountPeriodsView(ctx).revision, kind: "plan", row: none });
    expect(saved.applied).toBe(true);
    expect(JSON.parse(fs.readFileSync(ctx.declarationsFile!, "utf8")).plans).toEqual([
      { provider: "claude", account: "claude-sm", plan: "none", from: "2026-06-18", until: "2026-07-01", evidence: "refund" }]);
    expect(loadPeriods(ctx.sqlite, PLAN_PERIODS).map((p) => [p.origin, p.subject, p.value])).toEqual([["declared", "claude-sm", "none"]]);
    expect(() => applyPeriodEdit(ctx, { revision: buildAccountPeriodsView(ctx).revision, kind: "plan",
      row: { ...none, plan: "none", from: "2026-08-01", until: "2026-08-05", amount_minor: 1800, currency: "EUR" } })).toThrow(/brak abonamentu/);
  } finally { ctx.close(); }
});
test("a plan edit with a renewal day saves it, names the billing cycles it recomputes and marks only that account", () => {
  const ctx = workspace();
  try {
    writeDeclarations(ctx, [], [{ provider: "claude", account: "claude-sm", plan: "max-20x", from: "2026-09-24T09:55:57.164Z", until: null, evidence: "payment" },
      { provider: "claude", account: "claude-kn", plan: "max-5x", from: "2026-04-08", until: "2026-05-08", evidence: "payment" }]);
    const revision = buildAccountPeriodsView(ctx).revision;
    const edit: PeriodEdit = { revision, kind: "plan", replace: { account: "claude-sm", from: "2026-09-24T09:55:57.164Z" },
      row: { provider: "claude", account: "claude-sm", plan: "max-20x", from: "2026-09-24T09:55:57.164Z", until: null, evidence: "payment",
        anchor: "2026-09-12T13:35:26.181Z", cycle_months: 1 } };
    expect(previewPeriodEdit(ctx, edit).billing).toEqual({ provider: "claude", account: "claude-sm", from: "2026-09-12T13:35:26.181Z" });
    // The tables already hold the file; the edit changes one account's row.
    applyPeriodDeclarations(ctx.sqlite, ctx.declarationsFile!);
    ctx.sqlite.exec("DELETE FROM billing_cycle_dirty");
    const saved = applyPeriodEdit(ctx, edit);
    // A monthly cycle is the default and is not written; the anchor is.
    expect(JSON.parse(fs.readFileSync(ctx.declarationsFile!, "utf8")).plans[0]).toEqual({ provider: "claude", account: "claude-sm", plan: "max-20x",
      from: "2026-09-24T09:55:57.164Z", until: null, evidence: "payment", anchor: "2026-09-12T13:35:26.181Z" });
    expect(saved.view.planPeriods.find((row) => row.account === "claude-sm")).toMatchObject({ anchor: "2026-09-12T13:35:26.181Z", cycleMonths: null });
    expect(ctx.sqlite.query("SELECT provider, account FROM billing_cycle_dirty").all()).toEqual([{ provider: "claude", account: "claude-sm" }]);
  } finally { ctx.close(); }
});
