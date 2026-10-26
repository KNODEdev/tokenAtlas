import fs from "node:fs";
import { Database } from "../src/db/sqlite";
import { resolveDbPath } from "../src/db";
import { configFile, expandPath } from "../src/config/paths";
import { buildCodexAccountingReport } from "../src/server/codex-accounting";
import { buildEraIndex } from "../src/server/eras";
import { createFetchHandler, periodEras, type AppContext } from "../src/server/api";
import { readAccountsV2 } from "../src/config/accounts-document";
import { loadAccountResolver } from "../src/server/account-resolver";

const [account = "codex1", since = "2026-06-12", until = "2026-09-09"] = process.argv.slice(2);
const rates = JSON.parse(fs.readFileSync(configFile("rate-cards.json"), "utf8"));
const config = readAccountsV2(configFile("accounts.json"));
const accounts = { ...config, sources: config.sources.map(source => ({ ...source,
  home: expandPath(source.home),
  ...(source.source_home ? { source_home: expandPath(source.source_home) } : {}),
})) };
const db = new Database(resolveDbPath(), { readonly: true });
try {
  const resolver = loadAccountResolver(db, accounts.subscriptions);
  const eras = buildEraIndex(periodEras(db, accounts), "instant");
  const phases: Record<string, number> = {};
  const start = performance.now();
  const report = buildCodexAccountingReport(db, rates, { account, since, until }, undefined, eras, true,
    (phase, ms) => { phases[phase] = Math.round(ms); }, undefined, undefined, resolver, accounts.sources);
  console.log(JSON.stringify({ milliseconds: Math.round(performance.now() - start), phases,
    events: report.events, tokens: report.tokens, windows: report.windows?.length,
    breakdownRows: report.breakdown.length, intervals: report.calibration?.intervals.length,
    bytes: JSON.stringify(report).length }, null, 2));
  if (process.env.BENCHMARK_HTTP === "1") {
    const fetch = createFetchHandler({ sqlite: db, rateCards: rates, eras, resolver, accounts,
      homeToSubId: new Map(), rootDir: process.cwd() } as AppContext);
    const url = `http://benchmark/api/codex-accounting?${new URLSearchParams({ account, since, until })}`;
    for (let run = 1; run <= 2; run++) {
      const started = performance.now();
      const response = await fetch(new Request(url));
      const body = await response.text();
      console.log(JSON.stringify({ run, httpMilliseconds: Math.round(performance.now() - started), cache: response.headers.get("X-Cache"), status: response.status, bytes: body.length }));
    }
  }
} finally { db.close(); }
