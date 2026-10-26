import fs from "node:fs";
import type { Database } from "../db/sqlite";
import { ARCHIVE_ROOT, ARCHIVE_LOGICAL_ROOT, toArchivePhysicalPath, configFile } from "../config/paths";
import { bindCanonicalArchiveRoot, readCanonicalArchiveRoot } from "../config/archive-paths";
import { readArchiveIdentity } from "../config/archive-location";
import { ledgerCopyAnchorFromArchive } from "../db/codex-ledger-copies";
import { enqueueCodexLedgerRuleChanges, processCodexLedgerBatch, readCodexLedgerProducerProgress } from "../db/codex-ledger-producer";
import { compileCodexLedgerPolicy } from "./codex-ledger-policy";
import { codexLedgerSettings } from "./codex-ledger-settings";
import { codexHomeSource } from "./event-source";
import type { SourceDeclaration } from "./archive-source";
import type { RateCard } from "./pricing";
import type { UsagePriceBatch } from "../db/usage-price-totals";
import { codexLedgerWorkPending } from "../db/codex-ledger-state";
import { codexLedgerFillState } from "../db/codex-ledger-fill";

/** Reported when the writer must stop for another holder of the write lease; the work waits for the next turn. */
export const USAGE_PRICE_WRITER_BUSY = "usage-price-writer-busy";
/** Background-only writer; report callers receive readiness without launching preparation. */
export interface CodexLedgerPreparationBatch extends UsagePriceBatch { progressed:boolean; executablePending:boolean }

type LedgerSettings = { settings: ReturnType<typeof codexLedgerSettings>; policy: ReturnType<typeof compileCodexLedgerPolicy> };
/**
 * The ledger policy of a rate card object, compiled once: the background writer keeps one object while the file
 * is unchanged (analysis-maintenance-worker.ts), and compiling it took about 40 ms of every idle turn.
 */
const compiled = new WeakMap<RateCard, LedgerSettings>();
/** The saved file's revision, parsed again only when its text changed (it is re-read for every staleness check). */
let savedCard: { raw: string; revision: string } | null = null;
/**
 * The rule changes this connection applied last, with what they were applied from: the settings object, the
 * commits of other connections (`PRAGMA data_version`) and this connection's own changes. While none of them
 * moved and no rule scope was left queued, applying them again compares the same bands and writes nothing.
 */
const appliedRules = new WeakMap<Database, { settings: LedgerSettings["settings"]; dataVersion: number; changes: number }>();
const commitStamp = (db: Database) => ({
  dataVersion: (db.query("PRAGMA data_version").get() as { data_version: number }).data_version,
  changes: (db.query("SELECT total_changes() AS n").get() as { n: number }).n,
});

/**
 * One slice of the Codex ledger: producer batches for 250 ms, like every provider's slice of a
 * turn. A turn of 0 ms (one pass over the providers) runs one batch.
 */
export function advanceCodexLedger(db: Database, rates: RateCard, sources: readonly SourceDeclaration[],
  budget: { limit?: number; turnMs?: number; /** False once the writer must stop (between batches). */ canWrite?: () => boolean } = {}): CodexLedgerPreparationBatch {
  if (db.inTransaction) throw new Error("Codex ledger preparation requires a closed report snapshot");
  const has = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!has("codex_price_ledger_events") || !has("usage_ledger_dirty")) return { complete: false, processed: 0, progressed:false, executablePending:false, reason: "codex-ledger-schema-pending" };
  const stopped = () => budget.canWrite ? !budget.canWrite() : false;
  if (stopped()) return { complete: false, processed: 0, progressed:false, executablePending:false, reason: USAGE_PRICE_WRITER_BUSY };
  let ledger = compiled.get(rates);
  if (!ledger) {
    const settings = codexLedgerSettings(rates);
    compiled.set(rates, ledger = { settings, policy: compileCodexLedgerPolicy(settings.policy) });
  }
  const { settings, policy } = ledger;
  const cardPath = configFile("rate-cards.json"), persisted = fs.existsSync(cardPath);
  const policyIsCurrent = () => {
    if(!persisted)return true;
    if(!fs.existsSync(cardPath))return false;
    const raw=fs.readFileSync(cardPath,"utf8");
    if(savedCard?.raw!==raw)savedCard={raw,revision:codexLedgerSettings(JSON.parse(raw)).revision};
    return savedCard.revision===settings.revision;
  };
  const applied = appliedRules.get(db), before = commitStamp(db);
  if (applied?.settings !== settings || applied.dataVersion !== before.dataVersion || applied.changes !== before.changes) {
    enqueueCodexLedgerRuleChanges(db, { bands: policy.baseBands, rulesRevision: settings.semantic_revision, policy: policy.policy, policyIsCurrent });
    if (codexLedgerWorkPending(db, ["rules"])) appliedRules.delete(db);
    else appliedRules.set(db, { settings, ...commitStamp(db) });
  }
  const archiveId = readArchiveIdentity(ARCHIVE_ROOT);
  const binding = readCanonicalArchiveRoot(ARCHIVE_ROOT) ?? (archiveId ? bindCanonicalArchiveRoot(null, archiveId, ARCHIVE_ROOT) : null);
  const factsRevision = has("vendor_sync_revisions")
    ? ((db.query("SELECT data_revision revision FROM vendor_sync_revisions WHERE vendor='codex'").get() as { revision: number } | null)?.revision ?? 0) : 0;
  let processed = 0, progressed = false;
  const deadline = performance.now() + (budget.turnMs === 0 ? 0 : 250);
  do {
    if (stopped()) return { complete: false, processed, progressed, executablePending:false, reason: USAGE_PRICE_WRITER_BUSY };
    const batch = processCodexLedgerBatch(db, { bands: policy.baseBands, policy: policy.policy, factsRevision,
      rulesRevision: settings.semantic_revision, policyIsCurrent, batchSize: budget.limit ?? 500,
      // A batch ends with the slice, so another provider's turn is never kept waiting by this one (a turn of
      // 0 ms is one pass: its batch is bounded by its size alone).
      ...(budget.turnMs === 0 ? {} : { budgetMs: Math.max(0, deadline - performance.now()) }),
      anchorOf(home, file) {
        const source = home === null ? null : codexHomeSource(home, sources, ARCHIVE_LOGICAL_ROOT);
        return binding && source ? ledgerCopyAnchorFromArchive(binding, source, toArchivePhysicalPath(file)) : null;
      } });
    processed += batch.processed + batch.resolved;
    progressed ||= batch.progressed;
    if (batch.ready || !batch.progressed) break;
  } while (performance.now() < deadline);
  const progress = readCodexLedgerProducerProgress(db);
  const executablePending = !stopped() && (codexLedgerWorkPending(db, ["copy", "rules", "identity", "day", "session", "activity"]) || !!codexLedgerFillState(db));
  return { complete: progress.ready, processed, progressed, executablePending,
    ...(progress.blockedTotal ? { reason: "codex-ledger-source-binding-missing" } : {}) };
}
