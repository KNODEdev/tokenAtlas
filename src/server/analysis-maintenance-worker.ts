import { parentPort, workerData } from "node:worker_threads";
import { Database } from "../db/sqlite";
import { rateCardsFileReader } from "./rate-cards-file";
import type { CurrentConfig } from "./current/registry";
import type { RateCard } from "./pricing";
import type { AnalysisMaintenanceResult } from "./analysis-maintenance";
import { BacklogProgress, ProgressRegistry, progressDirectory } from "../sync/progress";
import { runBackgroundTurn } from "./background-jobs";
import type { JournalDeliveryTarget } from "../providers/core/journal";
import { WriteLease } from "../db/write-lease";
import type { WindowAnswer } from "../db/window-answers";
import { NativeFirstTokenReader } from "./first-token-producer";

/**
 * The background writer thread (U2.1): one connection, one turn per message, the jobs of
 * background-jobs.ts in order. A backlog uses up to two seconds of a turn (`turnMs`); ordinary
 * turns end after one pass.
 *
 * Each turn writes under the write lease (U2.2): taken at the start, checked between batches
 * (a sync run or remap that asks for it gets it at the next batch boundary) and given back at
 * the end of the turn. A turn that cannot take it runs only the read-only jobs.
 */
const options = workerData as { dbPath: string; turnMs?: number };
const turnMs = options.turnMs ?? 2000;

/**
 * The rate cards, read again only when the file changed: the jobs key what they derive from them (ledger
 * policy, reference valuations) by this object, so an unchanged file must give the same one every turn.
 */
const rateCardsFile = rateCardsFileReader();
const readRateCards = (): RateCard | null => rateCardsFile().rates;

const db = new Database(options.dbPath, { readwrite: true, create: false });
const progress = new ProgressRegistry(progressDirectory(options.dbPath));
const backlog = new BacklogProgress(progress);
db.exec("PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
const lease = new WriteLease(db, "background");
const firstTokenReader = new NativeFirstTokenReader(() => parentPort!.postMessage({ type: "first-token-ready" }));
parentPort!.on("message", (message: { config: CurrentConfig; firstTokenOnly?: boolean; journal?: JournalDeliveryTarget | null; answers?: WindowAnswer[] } | { close: true }) => {
  if ("close" in message) { void firstTokenReader.close().finally(() => { db.close(); parentPort!.close(); }); return; }
  try {
    const rates = readRateCards();
    const writing = lease.tryAcquire();
    let result: AnalysisMaintenanceResult;
    try {
      result = runBackgroundTurn({ db, config: message.config, rates, journal: message.journal ?? null, answers: message.answers ?? [],
        firstTokenReader, firstTokenOnly: message.firstTokenOnly, turnMs,
        canWrite: () => writing && lease.mayContinue(), holdsWriter: () => writing && lease.held, progress, backlog });
    } finally { if (lease.held) lease.release(); }
    parentPort!.postMessage(result satisfies AnalysisMaintenanceResult);
  } catch (error) {
    parentPort!.postMessage({ catchUpNeeded: false, errors: { turn: error instanceof Error ? error.message : String(error) } } satisfies AnalysisMaintenanceResult);
  }
});
