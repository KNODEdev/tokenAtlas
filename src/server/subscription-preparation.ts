import type { Database } from "bun:sqlite";
import type { SourceDeclaration } from "./archive-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import type { RateCard } from "./pricing";
import type { UsagePriceBatch } from "../db/usage-price-totals";
import { usageProviderIds } from "./subscription-accounting-adapters";
import { advanceCodexLedger, USAGE_PRICE_WRITER_BUSY, type CodexLedgerPreparationBatch } from "./codex-ledger-preparation";
import { advanceUsageLedger } from "./usage-ledger-producer";

/** One background turn: the last Codex result, and whether another provider still has queued work. */
export interface UsagePricesTurn { codex?: CodexLedgerPreparationBatch; othersPending: boolean }

/**
 * Advance every provider's valuations: the background writer's usage-price job (background-jobs.ts).
 * Reports never value anything; a report that finds a ledger behind answers "preparing".
 *
 * A backlog (first fill, a large late arrival) repeats passes over all providers until `turnMs`
 * is spent, so the fixed cost of a worker turn is paid once per turn rather than once per small
 * batch; each provider keeps its own bounded 250 ms slice per pass, so none starves another. With
 * no work the first pass finds nothing and the turn ends at once.
 */
export function advanceAllUsagePrices(db: Database, rates: RateCard, sources: readonly SourceDeclaration[],
  _sourceHomes: readonly string[], budget: { limit?: number; steps?: number; turnMs?: number;
    /** False once the writer must stop (checked between batches). */ canWrite?: () => boolean;
    /** Rows per step and steps per pass of the usage ledger; by default a 250 ms slice of 2000-row steps. */
    ledger?: { limit?: number; steps?: number } } = {}): UsagePricesTurn {
  let codex:CodexLedgerPreparationBatch|undefined, othersPending = false;
  const stopped = () => budget.canWrite ? !budget.canWrite() : false;
  const turnEnd = performance.now() + (budget.turnMs ?? 0);
  for (;;) {
    let progressed = false;
    othersPending = false;
    for (const provider of usageProviderIds()) {
      if (stopped()) return {codex, othersPending};
      if (provider === "codex") {
        const batch = advanceCodexLedger(db, rates, sources, budget);
        codex=batch;
        if (batch.reason === USAGE_PRICE_WRITER_BUSY) return {codex, othersPending};
        progressed ||= batch.progressed && batch.executablePending;
        continue;
      }
      const step = advanceUsageLedger(db, provider, rates, ARCHIVE_LOGICAL_ROOT,
        { budgetMs: 250, ...budget.ledger, stop: stopped });
      // A discarded ledger rebuilds on the next call, so it counts as work left.
      if (!step.complete && (step.processed || step.reason)) progressed = othersPending = true;
    }
    if (!progressed || performance.now() >= turnEnd) return {codex, othersPending};
  }
}
