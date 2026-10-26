import type { Database } from "bun:sqlite";
import type { AccountResolver } from "../server/account-resolver";
import type { UsagePriceAmount } from "./usage-price-totals";
import { readCodexLedgerCompatibilityDays, readCodexLedgerCompatibilityMeterModels, sumCodexLedgerCompatibilityAmounts,
  type CodexLedgerReadContext } from "./codex-ledger-adapters";

export type CodexRegisterQuality = Record<"duplicates" | "conflicts" | "conflicted_identities" | "approximate_time_events"
  | "invalid_token_events" | "unattributed_events" | "unknown_speed_tokens", number>;
export interface CodexRegisterDay {
  day: string; dim: string; selected: boolean; account: string | null; home: string | null; model: string | null;
  /** Open tier identity, or unknown when the original raw evidence is not mapped. */
  speed: string; subject: string | null; billing_mode: string | null; surface: string | null; nested: string | null;
  calls: number; tokensReported: number; tokens: Record<string, number>; first_ts: string; last_ts: string;
  variants: Record<string, UsagePriceAmount>; quality: CodexRegisterQuality;
}
export interface CodexMeterModelRow {
  home: string; path: string; meter_reset: number; account: string; spark: boolean; main: boolean;
}
export interface CodexRegisterRange { since: string; until: string }

/** Compatibility shapes read exclusively from published exact bases; `selected` marks canonical calls (duplicate copies are resolved at build). */
export function readCodexRegisterDays(db: Database, _scope: string, range: CodexRegisterRange,
  resolver: AccountResolver, ledger?: CodexLedgerReadContext): CodexRegisterDay[] {
  return readCodexLedgerCompatibilityDays(db, range, resolver, ledger);
}
/** Carries rational totals through compatibility aggregation; presentation happens after the sum. */
export function sumCodexRegisterAmounts(rows: Iterable<UsagePriceAmount | undefined>): UsagePriceAmount {
  return sumCodexLedgerCompatibilityAmounts(rows);
}
export function readCodexMeterModels(db: Database, _scope: string, range: CodexRegisterRange,
  resolver: AccountResolver, account?: string, ledger?: CodexLedgerReadContext): CodexMeterModelRow[] {
  return readCodexLedgerCompatibilityMeterModels(db, range, resolver, account, ledger);
}
