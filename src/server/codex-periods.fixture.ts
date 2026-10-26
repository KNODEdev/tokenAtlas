import type { Database } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import type { DatedPeriod } from "./account-periods";
import type { SourceDeclaration } from "./archive-source";
import { codexHomeSource } from "./event-source";
import { normEraVendor } from "./eras";

export interface CodexEraFixture extends SourceDeclaration { id: string; from?: string; until?: string }

/**
 * Test support: a fixture written before stage 4 declares Codex ownership as `accounts.json` eras.
 * Production reads a Codex row's account from the period of its archive source (W6), so each era
 * becomes a declared period of the source its home names — what stage 1 did once with the live
 * eras, to the day. Eras without an archive source (a home outside the archive) declare nothing.
 */
export function declareCodexEraPeriods(db: Database, eras: readonly CodexEraFixture[], options: { replace?: boolean; root?: string } = {}): void {
  const root = options.root ?? ARCHIVE_LOGICAL_ROOT;
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS account_periods(id INTEGER PRIMARY KEY,provider TEXT NOT NULL,source TEXT NOT NULL,from_ts TEXT NOT NULL,
    until_ts TEXT,account TEXT NOT NULL,origin TEXT NOT NULL,first_seen TEXT,last_seen TEXT,readings INTEGER NOT NULL DEFAULT 0,evidence TEXT NOT NULL)`);
  // `replace` states the fixture's whole Codex history; otherwise the eras add to what is declared.
  const declared = loadPeriods(db, ACCOUNT_PERIODS).filter((period) => period.origin === "declared"
    && !(options.replace && normEraVendor(period.provider) === "codex"));
  for (const era of eras) {
    if (!["codex", "openai"].includes(normEraVendor(era.vendor))) continue;
    const source = codexHomeSource(era.home, eras, root) ?? codexHomeSource(era.source_home, eras, root);
    const from = era.from ?? "2000-01-01", until = era.until ?? null;
    if (!source || declared.some((p) => p.subject.toLowerCase() === source && p.value === era.id && p.from === from && p.until === until)) continue;
    declared.push({ provider: "codex", subject: source, from, until, value: era.id,
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" } satisfies DatedPeriod);
  }
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, declared);
}
