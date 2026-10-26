import { readCodexLedgerOwnedSeries, codexLedgerReadContext, codexLedgerPendingReason } from "../db/codex-ledger-adapters";
import type { Database } from "../db/sqlite";
import type { RateCard } from "./pricing";
import { readCodexLedgerState } from "../db/codex-ledger-state";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { loadAccountResolver } from "./account-resolver";
import { tableExists } from "./project-cost-schema";
import type { Rational } from "../db/price-ledger-exact";
import { resolveCodexSubId } from "./capacity-equivalents";
import { codexProjectReportLedgerRange } from "./codex-ledger-report-dependencies";

/** The one Codex variant the project report values: its API equivalent at Standard (with its token-bucket split). */
const API_STANDARD_ONLY = ["api_standard"] as const;

type CodexOwnedRow = ReturnType<typeof readCodexLedgerOwnedSeries<typeof API_STANDARD_ONLY>>[number];

/**
 * The Codex ledger groups the project report reads (owner resolved, Standard API value only), or null without
 * Codex history. A ledger still being prepared raises SubscriptionFactsPending: this read never reprices.
 */
export function readProjectCodexRows(sqlite: Database, rateCards: RateCard, range: { since?: string; until?: string }):
  { rows: CodexOwnedRow[]; ledger: ReturnType<typeof codexLedgerReadContext> } | null {
  const nativeRange = { ...range, dependencyBases: ["api_equivalent_usd"] as const };
  const codexAttributable = !!readCodexLedgerState(sqlite) || tableExists(sqlite, "events")
    && !!sqlite.query("SELECT 1 FROM events LIMIT 1").get();
  const ledger = codexAttributable ? codexLedgerReadContext(rateCards) : undefined;
  if (ledger) {
    const pending = codexLedgerPendingReason(sqlite, { ...ledger,range:nativeRange });
    if (pending) throw new SubscriptionFactsPending(`Codex project costs are awaiting background preparation (${pending})`, "codex");
  }
  if (!codexAttributable || !ledger) return null;
  return { ledger, rows: readCodexLedgerOwnedSeries(sqlite, nativeRange, loadAccountResolver(sqlite), ledger, API_STANDARD_ONLY, { coarse: true }) };
}

/** The subscription and day a Codex group counts for, and its Standard API value (null: unknown); null for an unselected copy. */
export function codexPlanRow(group: CodexOwnedRow["group"], account: string | null): { subId: string; day: string; value: Rational | null } | null {
  // Duplicate copies were resolved when the ledger was built.
  if (!group.selected) return null;
  return { subId: resolveCodexSubId(account), day: group.stored.day, value: group.variants.api_standard.value };
}

/** Codex project costs read a prepared ledger over the report's range and its seven-day edges. */
export function assertCodexProjectReady(sqlite: Database, rates: RateCard, options: { since?: string; until?: string }): void {
  const ledgerHead = readCodexLedgerState(sqlite);
  const hasCodex = !!ledgerHead || tableExists(sqlite,"events") && !!sqlite.query("SELECT 1 FROM events LIMIT 1").get();
  const nativeRange=codexProjectReportLedgerRange(options);
  const ledger=hasCodex?codexLedgerReadContext(rates):undefined;
  if (ledger) {
    const pending = codexLedgerPendingReason(sqlite,{...ledger,range:nativeRange});
    if (pending) throw new SubscriptionFactsPending(`Codex project costs are awaiting background preparation (${pending})`,"codex");
  }
}
