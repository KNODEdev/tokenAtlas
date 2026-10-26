import type { Database } from "bun:sqlite";
import { ACCOUNT_PERIODS, recordPeriodReading } from "../db/period-store";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { accountReadingOf } from "./account-period-feed";
import type { SourceDeclaration } from "./archive-source";

export interface ObservedReading {
  /** The account the reading names (Codex subscription or vendor account id). */
  account: string;
  email: string | null;
  ts: string;
  provider?: string;
  home?: string;
  machine?: string;
  login?: string;
}

/**
 * Test support: one probe reading naming the signed-in account, fed into the observed account periods
 * the way the server's feed does. Returns the archive source the reading maps to.
 */
export function recordObservedReading(sqlite: Database, declarations: readonly SourceDeclaration[], reading: ObservedReading): string {
  const provider = reading.provider ?? "codex";
  const home = reading.home ?? "C:/Users/x/.codex";
  const machine = reading.machine ?? "PC", login = reading.login ?? "x";
  const extra = JSON.stringify(provider === "codex"
    ? { home, codex_account: { subscription: reading.account, email: reading.email, key: `account:${reading.account}`, home, login, machine } }
    : { home, vendor_account: { id: reading.account, email: reading.email, key: `${provider}:${reading.account}` } });
  const row = sqlite.query(`INSERT INTO probe_windows (provider, subject, ts, kind, reported_percent_side, used_percent, profile, extra, machine)
    VALUES (?, ?, ?, 'primary', 'used', 10, ?, ?, ?) RETURNING id, provider, ts, plan, machine, profile, extra`)
    .get(provider, reading.account, reading.ts, login, extra, machine) as Parameters<typeof accountReadingOf>[0];
  const period = accountReadingOf(row, { declarations, archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN });
  if (!period || period === "unmapped") throw new Error("test reading does not map to an archive source");
  recordPeriodReading(sqlite, ACCOUNT_PERIODS, period);
  return period.subject;
}
