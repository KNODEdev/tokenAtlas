import type { Database } from "bun:sqlite";
import { advanceLimitWindows, type LimitWindowProducerOptions } from "./limit-window-producer";

/**
 * Runs the maintenance worker's limit-window producer on a fixture until idle, as the worker would
 * between a test's writes and its reads. Readers never compute windows themselves.
 */
export function prepareLimitWindowsFixture(db: Database, options: Partial<LimitWindowProducerOptions> = {}): void {
  for (let turn = 0; turn < 10_000; turn++) {
    const result = advanceLimitWindows(db, { sources: [], cycles: { windows: [] }, manualCapacity: () => [], budgetMs: 1e9, ...options });
    if (!result.pending) return;
    if (!result.progressed) return; // The probe index is preparing: readers answer "preparing", as in production.
  }
  throw new Error("Limit window fixture did not settle");
}
