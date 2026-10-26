import fs from "node:fs";
import { Database } from "../db/sqlite";
import type { RecordValue } from "./canonical-json";
import { parseAccountsV2, type AccountsV2 } from "./accounts-v2";

/** The declarations document; a missing file reads as empty, anything but an object is refused. */
export function readAccountsDocument(file: string): RecordValue {
  if (!fs.existsSync(file)) return { version: 2, subscriptions: [], sources: [] };
  const document: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return parseAccountsV2(document);
}

/** Runtime readers reject the old format, including when the file is opened outside AppContext. */
export function readAccountsV2(file: string): AccountsV2 {
  if (!fs.existsSync(file)) throw new Error(`accounts v2: missing configuration: ${file}`);
  return parseAccountsV2(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * A new machine: no declarations and a database without a completed sync. It starts into the
 * setup wizard, which writes accounts.json. A machine that has synced and lost the file keeps
 * failing, because that means an archive that is not reachable yet, not a first run. Failed
 * attempts do not count: a sync tried before the wizard finished must not end the first run.
 */
export function isFirstRun(accountsFile: string, databasePath: string): boolean {
  if (fs.existsSync(accountsFile)) return false;
  if (!fs.existsSync(databasePath)) return true;
  const db = new Database(databasePath, { readonly: true });
  try {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_runs'").get();
    return !table || !db.query("SELECT 1 FROM sync_runs WHERE status IN ('success', 'partial_success') LIMIT 1").get();
  } finally {
    db.close();
  }
}

/** Startup declarations: empty on a first run, otherwise the v2 document is required. */
export function readStartupAccounts(accountsFile: string, databasePath: string): AccountsV2 {
  return isFirstRun(accountsFile, databasePath)
    ? parseAccountsV2({ version: 2, subscriptions: [], sources: [] })
    : readAccountsV2(accountsFile);
}
