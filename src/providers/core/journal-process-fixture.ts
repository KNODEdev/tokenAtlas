import { dailyJournalFile } from "./journal-files";
/** Test subprocess for real process-death and concurrent-drainer boundaries. */
import path from "node:path";
import { interruptJournalFsync } from "./journal-fault-fixture";
import { Database } from "../../db/sqlite";
import { flushGaugeJournal } from "./journal";

const [dbPath, journalRoot, archiveRoot, mode] = process.argv.slice(2);
if (!dbPath || !journalRoot || !archiveRoot) throw new Error("Missing isolated fixture paths");
const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA busy_timeout = 2000");
if (mode === "crash-after-fsync") {
  interruptJournalFsync(path.join(journalRoot, dailyJournalFile("probe_windows.jsonl", new Date())), () => process.exit(73));
}
const result = flushGaugeJournal(sqlite, { journalRoot, archiveRoot });
sqlite.close();
console.log(JSON.stringify(result));
if (result.error) process.exitCode = 1;
