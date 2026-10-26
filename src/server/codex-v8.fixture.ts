import { prepareWindowUsageFixture } from "./window-usage.fixture";
import fs from "node:fs";
import type {Database} from "bun:sqlite";
import {ARCHIVE_LOGICAL_ROOT} from "../config/paths";
import {loadAccountResolver} from "./account-resolver";
import {buildCodexAccountingReport as readReport} from "./codex-accounting";
import {prepareProbeReaderFixture} from "./probe-reader.fixture";
import {prepareCodexLedgerFixture} from "./codex-ledger.fixture";
import {indexSubscriptionHomes} from "./capacity-equivalents";
import {prepareLimitWindowsFixture} from "./limit-windows.fixture";

export const codexFixtureSources=["/archive","/local/.codex","laptop","desktop"].map(source_home=>({
  id:"codex1",vendor:"codex",home:`${ARCHIVE_LOGICAL_ROOT}/codex/fixture`,source_home,
}));
export function codexFixturePeriods(db:Database, account="codex1", source="codex/fixture") {
  if(db.query("SELECT 1 FROM sqlite_master WHERE name='account_periods'").get())return;
  db.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql",import.meta.url),"utf8"));
  db.query("INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex',?,?, '2000-01-01T00:00:00Z','declared','fixture')").run(source,account);
}
export function buildFixtureCodexReport(...args:Parameters<typeof readReport>) {
  codexFixturePeriods(args[0]);
  prepareProbeReaderFixture(args[0],[{id:"codex1",vendor:"codex",home:`${ARCHIVE_LOGICAL_ROOT}/codex/fixture`,source_home:"/archive"}]);
  args[9]??=loadAccountResolver(args[0]);args[10]??=codexFixtureSources;
  const homes=indexSubscriptionHomes([...(args[3]??new Map<string,string>())].map(([home,id])=>({home,id})),args[10]);
  prepareCodexLedgerFixture(args[0],args[1],homes);
  prepareLimitWindowsFixture(args[0],{sources:args[10],manualCapacity:()=>[]});
  prepareWindowUsageFixture(args[0],{rateCards:args[1]});
  return readReport(...args);
}
