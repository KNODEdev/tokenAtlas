import type { Database } from "../db/sqlite";
import { codexLedgerWorkPending, readCodexLedgerState } from "../db/codex-ledger-state";
import { processCodexContextBatch, readCodexContextState, type ContextBatchResult } from "../db/codex-context-producer";
import { compileCodexLedgerPolicy, type CompiledCodexLedgerPolicy, type CodexLedgerPolicy } from "./codex-ledger-policy";

const policies = new WeakMap<Database, { json: string; compiled: CompiledCodexLedgerPolicy }>();
/** The registry's background-only entry point. It follows published ledger rules, never launches a ledger build. */
export function advanceCodexContextPrices(db: Database, options: { limit?: number; canWrite?(): boolean } = {}): ContextBatchResult | null {
  if (!readCodexContextState(db) || options.canWrite?.() === false) return null;
  // A base-rule batch may have published new bands before its final policy snapshot. Keep the
  // last context result provisional until those paired inputs have the same published owner.
  if (codexLedgerWorkPending(db, ["rules"])) return { processed: 0, eventsWritten: 0, aggregatesWritten: 0, pending: true };
  const json = readCodexLedgerState(db)?.rules_json;
  if (!json) return null;
  let policy = policies.get(db);
  if (policy?.json !== json) {
    policy = { json, compiled: compileCodexLedgerPolicy(JSON.parse(json) as CodexLedgerPolicy) };
    policies.set(db, policy);
  }
  return processCodexContextBatch(db, { ...options, policy: policy.compiled,
    policyIsCurrent: () => readCodexLedgerState(db)?.rules_json === json });
}
