import { afterEach, expect, test } from "bun:test";
import { contextPreviewFixture } from "./codex-context-preview.fixture";
import { buildRepoHistory, buildRepoHistoryCancellable, HistoryAbortedError, type RepoHistoryOpts } from "./repo-history";
import { buildProjectCost } from "./project-cost";
import { contextPreviewReader } from "./codex-context-read";
import { captureContextReadAsync, contextReadScope, inContextRead, runContextRead } from "../db/codex-context-read-scope";
import { codexLedgerCompatibilityDays, codexLedgerReadContext, readCodexLedgerOwnedSeries } from "../db/codex-ledger-adapters";
import { CODEX_LEDGER_VARIANTS } from "../db/codex-price-ledger-read";
import { loadAccountResolver } from "./account-resolver";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { dailyAggregate } from "./project-cost-daily";
import { overrideProjectRules, projectRulesOverride } from "../projects/resolve";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { SubscriptionFactsPending } from "../db/subscription-facts";

const fixtures: ReturnType<typeof contextPreviewFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.db.close(); });
function fixture(included = false) {
  const f = contextPreviewFixture(included); fixtures.push(f); f.fill(); return f;
}
function options(f: ReturnType<typeof fixture>): RepoHistoryOpts {
  return { repo: null, projectId: "a", granularity: "day", by: "account", idleGapMinutes: 15, ...f.range,
    rateCards: f.rates, homeToSubId: f.ctx.homeToSubId, declarations: f.ctx.accounts.subscriptions,
    plansCatalog: f.ctx.plansCatalog, machineOf: () => null };
}

test("project day sums reuse fresh worker maps, follow WAL corrections and survive reopen without caching a writer rollback", () => {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-cost-read-")), file = path.join(directory, "facts.sqlite");
  fs.writeFileSync(file, f.db.serialize());
  const writer = new Database(file); writer.exec("PRAGMA journal_mode=WAL");
  overrideProjectRules(writer, projectRulesOverride(f.db)!);
  const reader = new Database(file, { readonly: true }), original = reader.query.bind(reader);
  let groupReads = 0;
  reader.query = ((sql: string) => { if (sql.startsWith("SELECT g.day")) groupReads++; return original(sql); }) as typeof reader.query;
  const read = (db: Database) => db.transaction(() => dailyAggregate(db, f.rates, new Map(f.ctx.homeToSubId), f.range)).deferred();
  const changeOwner = (account: string) => replaceDeclaredPeriods(writer, ACCOUNT_PERIODS,
    loadPeriods(writer, ACCOUNT_PERIODS).filter(period => period.origin === "declared").map(period =>
      ({ ...period, value: period.value === "before" ? "before" : account })));
  try {
    const before = read(reader); expect(groupReads).toBeGreaterThan(0); groupReads = 0;
    expect(read(reader)).toEqual(before); expect(groupReads).toBe(0);
    writer.exec("INSERT OR REPLACE INTO meta(key,value) VALUES('unrelated-progress','1')");
    expect(read(reader)).toEqual(before); expect(groupReads).toBe(0);
    reader.transaction(() => {
      expect(read(reader)).toEqual(before);
      changeOwner("corrected");
      expect(read(reader)).toEqual(before);
    })();
    const corrected = read(reader);
    expect(corrected).not.toEqual(before); expect(corrected).toEqual(read(writer));
    expect(corrected.bucketOrder.some(row => row.subId === "corrected")).toBe(true);
    expect(() => writer.transaction(() => {
      changeOwner("rolled-back"); expect(read(writer)).not.toEqual(corrected); throw new Error("rollback");
    })()).toThrow("rollback");
    expect(read(writer)).toEqual(corrected);
    // A token-only publication can leave the price fingerprint unchanged.
    writer.exec("UPDATE codex_price_ledger_aggregates SET reported=reported+1; UPDATE usage_ledger_state SET revision=revision+1,published_revision=published_revision+1 WHERE provider='codex'");
    const published = read(reader);
    expect(published).not.toEqual(corrected); expect(published).toEqual(read(writer));
    const reopened = new Database(file, { readonly: true });
    try { expect(read(reopened)).toEqual(published); expect(reopened.query("SELECT total_changes() n").get()).toEqual({ n: 0 }); }
    finally { reopened.close(true); }
    writer.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','day','2026-09-01'); UPDATE codex_price_ledger_aggregates SET reported=reported+1");
    expect(read(reader)).not.toEqual(published); expect(read(reader)).toEqual(read(writer));
    writer.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"m\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-01-01\",\"untilDay\":null,\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
    expect(() => read(reader)).toThrow(SubscriptionFactsPending);
    expect(reader.query("SELECT total_changes() n").get()).toEqual({ n: 0 });
  } finally {
    overrideProjectRules(writer, null); reader.close(true); writer.close(true);
    if (path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(os.tmpdir())) throw new Error("Unexpected fixture cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("project normalization projects the same grouped values, reasons, ordering and ownership as the full register", () => {
  const f = fixture();
  const rows = readCodexLedgerOwnedSeries<typeof CODEX_LEDGER_VARIANTS>(f.db, f.range, loadAccountResolver(f.db), codexLedgerReadContext(f.rates), undefined, { coarse: true });
  const full = codexLedgerCompatibilityDays(rows);
  const projected = codexLedgerCompatibilityDays(rows, ["normalized_usd"]);
  expect(projected).toEqual(full.map(row => ({ ...row, variants: { normalized_usd: row.variants.normalized_usd! } })));
  const partial = readCodexLedgerOwnedSeries(f.db, f.range, loadAccountResolver(f.db), codexLedgerReadContext(f.rates),
    ["api_standard", "normalized_usd"] as const, { coarse: true });
  expect(codexLedgerCompatibilityDays(partial, ["normalized_usd"])).toEqual(projected);
  expect(full.some(row => row.variants.normalized_usd!.value === null)).toBe(true);
});

test("paired histories reuse activity reads and equal independently assembled context views", async () => {
  const f = fixture(), query = f.db.query.bind(f.db);
  let activityReads = 0;
  f.db.query = ((sql: string) => {
    if (sql.includes("SUM(a.calls) calls, SUM(a.uncached+a.cached+a.writes+a.output) tokens")) activityReads++;
    return query(sql);
  }) as typeof f.db.query;
  const opts = options(f), plain = await buildRepoHistoryCancellable(f.db, opts);
  const ordinaryReads = activityReads; expect(ordinaryReads).toBeGreaterThan(0); activityReads = 0;
  const paired = await buildRepoHistoryCancellable(f.db, { ...opts, contextPreview: true });
  expect(activityReads).toBe(ordinaryReads);
  const { context_preview, context_preview_status, ...base } = paired;
  expect(base).toEqual(plain); expect(context_preview_status).toMatchObject({ ready: true, missing_groups: 0 });
  const reader = contextPreviewReader(f.db);
  expect(context_preview).toEqual(runContextRead(reader.scope, () => buildRepoHistory(f.db, opts)));
  for (const granularity of ["week", "month"] as const) for (const by of ["none", "model", "vendor"] as const) {
    const selected = { ...opts, projectId: "b", granularity, by };
    const expected = runContextRead(contextPreviewReader(f.db).scope, () => buildRepoHistory(f.db, selected));
    expect((await buildRepoHistoryCancellable(f.db, { ...selected, contextPreview: true })).context_preview).toEqual(expected);
  }
});

test("project paired inputs never leak to later requests or included-premium views", () => {
  const f = fixture(true), read = () => buildProjectCost(f.db, f.rates, f.ctx.homeToSubId,
    { ...f.range, plansCatalog: f.ctx.plansCatalog, declarations: f.ctx.accounts.subscriptions, contextPreview: true });
  const before = read(); expect(before.context_preview).toBeDefined();
  const { context_preview, context_preview_status, ...base } = before;
  expect(context_preview).toEqual(base);
  f.db.exec("UPDATE codex_context_state SET source_revision=source_revision+1");
  const pending = read(); expect(pending.context_preview).toBeUndefined(); expect(pending.context_preview_status!.ready).toBe(false);
  f.fill(); const refreshed = read();
  expect(refreshed.context_preview_status!.revision).toBeGreaterThan(context_preview_status!.revision);
  expect(refreshed).toEqual({ ...before, context_preview_status: { ...context_preview_status!, revision: refreshed.context_preview_status!.revision } });
});

test("async capture spans yields and releases context on cancellation or failure", async () => {
  const f = fixture(), scope = contextPreviewReader(f.db).scope;
  await expect(captureContextReadAsync(scope, async () => {
    expect(inContextRead(f.db)).toBe(true); expect(contextReadScope(f.db)).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(inContextRead(f.db)).toBe(true); expect(contextReadScope(f.db)).toBeUndefined();
    throw new Error("capture failed");
  })).rejects.toThrow("capture failed");
  expect(inContextRead(f.db)).toBe(false); expect(scope.capturing).toBe(false);
  const abort = new AbortController();
  await expect(buildRepoHistoryCancellable(f.db, { ...options(f), contextPreview: true }, {
    signal: abort.signal, onCheckpoint() { abort.abort(); },
  })).rejects.toBeInstanceOf(HistoryAbortedError);
  expect(inContextRead(f.db)).toBe(false);
  const read = await buildRepoHistoryCancellable(f.db, { ...options(f), contextPreview: true });
  expect(read.context_preview_status).toMatchObject({ ready: true, missing_groups: 0 });
});
