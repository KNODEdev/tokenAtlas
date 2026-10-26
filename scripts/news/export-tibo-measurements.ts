import { Database } from "../../src/db/sqlite";
import { activeDatabasePath } from "../../src/db";
import { withReadSnapshot } from "../../src/db/analysis";
import { readAccountsV2 } from "../../src/config/accounts-document";
import { configFile } from "../../src/config/paths";
import { loadRateCard } from "../../src/server/rate-cards-file";
import { loadAccountResolver } from "../../src/server/account-resolver";
import { readCodexOwnedTimedHours } from "../../src/server/ledger-sums";
import { modelSpeedSeries, type ModelSpeedSeries, type ModelSpeedPoint } from "../../src/server/model-speed";
import { readTiboMeasurements } from "./read-tibo-measurements";
import { tiboCohortKey, tiboComparison, tiboSample, tiboSpeedScope, type TiboHour } from "../../src/shared/tibo-measurements";
import { tiboBounds, tiboDate } from "../../src/shared/tibo-challenge";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";

/** Public output is a whitelist of anonymous aggregate fields, never raw register rows. */
const publicSpeedPoint = (point: ModelSpeedPoint): ModelSpeedPoint => ({
  at: point.at, calls: point.calls, timed_calls: point.timed_calls, timed_out: point.timed_out, timed_ms: point.timed_ms,
  speed: point.speed, long_calls: point.long_calls, long_out: point.long_out, long_ms: point.long_ms,
  long_speed: point.long_speed, coverage: point.coverage,
});
export function publicTiboMeasurements(hours: TiboHour[], histories: Map<string, ModelSpeedSeries[]>, now: number, excludedCalls: number) {
  const accounts = [...new Set(hours.map(row => row.account))].sort();
  const cohorts = new Map<string, TiboHour[]>();
  for (const row of hours) {
    const key = tiboCohortKey(row), rows = cohorts.get(key) ?? [];
    rows.push(row); cohorts.set(key, rows);
  }
  const list = [...cohorts.values()].sort((a, b) => b.reduce((sum, row) => sum + row.calls, 0) - a.reduce((sum, row) => sum + row.calls, 0));
  return { version: 1, generatedAt: new Date(now).toISOString(), excludedCalls, cohorts: list.map((rows, index) => {
    const first = rows[0]!, speed = tiboComparison(rows, 1, now), cache = tiboComparison(rows, 12, now);
    const history = histories.get(first.account)?.find(series => series.model === first.model) ?? null;
    return { id: `cohort-${index + 1}`, sample: accounts.indexOf(first.account) + 1,
      model: first.model, mode: first.mode, plan: first.plan, funding: first.funding,
      calls: rows.reduce((sum, row) => sum + row.calls, 0), scope: tiboSpeedScope(first),
      known: !!first.mode && !!first.plan, speed, cache,
      speedHistory: history ? { model: history.model, total: publicSpeedPoint(history.total),
        points: history.points.filter(point => point.at <= new Date(now).toISOString().slice(0, 10)).map(publicSpeedPoint) } : null,
      cacheHistory: Array.from({ length: 28 }, (_, index) => {
        const day = index + 1, bounds = tiboBounds(day);
        const sample = tiboSample(rows, bounds.from, Math.min(bounds.until, Math.floor(now / 3_600_000) * 3_600_000));
        return { day, date: tiboDate(day), value: sample.cache, calls: sample.calls, input: sample.input, cached: sample.cached };
      }),
    };
  }) };
}
export type PublicTiboMeasurements = ReturnType<typeof publicTiboMeasurements>;
export type PublicTiboCohort = PublicTiboMeasurements["cohorts"][number];

if (import.meta.main) {
  const outputIndex = process.argv.indexOf("--output");
  const outputArgument = outputIndex < 0 ? null : process.argv[outputIndex + 1];
  if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) {
    throw new Error("--output requires a destination JSON file");
  }
  const output = outputArgument ? resolve(outputArgument) : resolve(import.meta.dir, "../../config/news-tibo-measurements.json");
  const db = new Database(activeDatabasePath(), { readonly: true });
  try {
    const started = performance.now(), now = Date.now();
    const changes = () => (db.query("SELECT total_changes() n").get() as { n: number }).n;
    const before = changes();
    const data = withReadSnapshot(db, () => {
      const accounts = readAccountsV2(configFile("accounts.json")), rateCards = loadRateCard(configFile("rate-cards.json"));
      const measured = readTiboMeasurements({ sqlite: db, accounts, rateCards }, "__all__");
      const resolver = loadAccountResolver(db, accounts.subscriptions), histories = new Map<string, ModelSpeedSeries[]>();
      for (const account of new Set(measured.hours.map(row => row.account))) {
        histories.set(account, modelSpeedSeries(readCodexOwnedTimedHours(db, resolver, account,
          { until: new Date(now).toISOString().slice(0, 10), dependencyBases: ["api_equivalent_usd"] }), "day"));
      }
      return publicTiboMeasurements(measured.hours, histories, now, measured.excludedCalls);
    });
    if (changes() !== before) throw new Error("Readonly export unexpectedly changed the register");
    const directory = dirname(output);
    mkdirSync(directory, { recursive: true });
    const target = output, staged = target + ".stage";
    writeFileSync(staged, JSON.stringify(data)); renameSync(staged, target);
    console.log(JSON.stringify({ entry: "readTiboMeasurements + readCodexOwnedTimedHours/modelSpeedSeries (same Speed read path)",
      mode: "active database, readonly, one consistent snapshot", sample: { cohorts: data.cohorts.length,
        accounts: new Set(data.cohorts.map(row => row.sample)).size, generatedAt: data.generatedAt },
      excludes: "HTTP, browser, archive/import/repricing/rebuild; only anonymous aggregate fields published", ms: performance.now() - started, writes: 0 }));
  } finally { db.close(); }
}
