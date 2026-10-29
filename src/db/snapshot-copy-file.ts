import fs from "node:fs";
import { Database } from "./sqlite";

/** Startup owns the writer; materialize committed WAL pages before the OS copies the file. */
export function copySnapshotDatabaseFile(source: string, destination: string, onCopyReady?: (totalBytes: number) => void): void {
  const admission = new Database(source, { readwrite: true });
  let transaction = false;
  try {
    const { journal_mode: mode } = admission.query("PRAGMA journal_mode").get() as { journal_mode: string };
    if (mode === "wal") {
      admission.exec("BEGIN IMMEDIATE");
      transaction = true;
      // Hold the WAL writer lock while a second connection checkpoints already committed pages.
      const checkpoint = new Database(source, { readwrite: true });
      try {
        const result = checkpoint.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
          busy: number; log: number; checkpointed: number;
        };
        if (result.busy !== 0 || result.log < 0 || result.checkpointed < 0 || result.log !== result.checkpointed) {
          throw new Error("Database file copy requires a completed WAL checkpoint. Close other database users and retry. No copy was made.");
        }
      } finally { checkpoint.close(true); }
    } else {
      // A rollback-journal reader prevents changes to the main file until this copy finishes.
      admission.exec("BEGIN");
      transaction = true;
      admission.query("PRAGMA schema_version").get();
    }
    onCopyReady?.(fs.statSync(source).size);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } finally {
    try { if (transaction) admission.exec("ROLLBACK"); }
    finally { admission.close(true); }
  }
}
