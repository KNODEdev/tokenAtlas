import fs from "node:fs";
import { Database } from "../db/sqlite";
import { configFile } from "../config/paths";
import { resolveDbPath } from "../db";
import type { RateCard } from "./pricing";
import { accountingOptions, buildCodexAccountingReport } from "./codex-accounting";
import { buildEraIndex } from "./eras";
import { loadAccountResolver } from "./account-resolver";
import { codexPhysicalSourceHomes, restoreSubscriptionHomes } from "./capacity-equivalents";
import { readAccountsV2 } from "../config/accounts-document";
import { expandPath, ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { loadPeriods, ACCOUNT_PERIODS } from "../db/period-store";
import { effectiveDatedPeriods } from "./account-periods";
import { archiveFolderOf } from "./event-source";

export function runCodexAccountingCli(args = process.argv.slice(2)): void {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if (!["--db", "--rates", "--since", "--until", "--account", "--project"].includes(flag) || !value || value.startsWith("--")) {
      throw new Error("Usage: accounting:codex [--db path] [--rates path] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--account id] [--project id]");
    }
    values.set(flag.slice(2), value);
  }
  const options = accountingOptions(new URLSearchParams([...values]), new Date(), 36600);
  const card = JSON.parse(fs.readFileSync(values.get("rates") ?? configFile("rate-cards.json"), "utf8")) as RateCard;
  const config = readAccountsV2(configFile("accounts.json"));
  const sources = config.sources.map(source => ({ ...source, home: expandPath(source.home),
    ...(source.source_home ? { source_home: expandPath(source.source_home) } : {}) }));
  const db = new Database(resolveDbPath(values.get("db")), { readonly: true });
  try {
    const resolver = loadAccountResolver(db, config.subscriptions);
    const periods = effectiveDatedPeriods(loadPeriods(db, ACCOUNT_PERIODS));
    const eras = buildEraIndex(periods.map(period => ({ id: period.value, vendor: period.provider,
      home: sources.find(source => archiveFolderOf(source.home, ARCHIVE_LOGICAL_ROOT)?.key === period.subject)?.home,
      from: period.from, until: period.until ?? undefined })), "instant");
    const entries: Array<[string,string]> = [];
    for (const source of sources.filter(source => source.vendor === "codex")) {
      const key = archiveFolderOf(source.home, ARCHIVE_LOGICAL_ROOT)?.key;
      const account = key ? resolver.resolve("codex", key, null, new Date().toISOString()).account : null;
      if (account) for (const home of [source.home, source.source_home]) if (home) entries.push([home.toLowerCase(), account]);
    }
    const homes = restoreSubscriptionHomes(entries, codexPhysicalSourceHomes(sources), sources);
    console.log(JSON.stringify(buildCodexAccountingReport(db, card, options, homes, eras,true,undefined,undefined,undefined,resolver,sources), null, 2));
  }
  finally { db.close(); }
}
if (import.meta.main) {
  try { runCodexAccountingCli(); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
