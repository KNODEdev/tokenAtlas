import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/** Keep synchronous publication callers while SQLite's asynchronous backup runs in its own process. */
export function backupSnapshotDatabase(source: string, destination: string): void {
  // The backup API overwrites its target; reserve our new file without clobbering an existing one.
  fs.closeSync(fs.openSync(destination, "wx"));
  const child = Bun.spawnSync([process.execPath, import.meta.filename, source, destination], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(`SQLite snapshot backup failed: ${child.stderr.toString().trim() || child.signalCode || child.exitCode}`);
  }
}

if (import.meta.main) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination || path.resolve(source) === path.resolve(destination))
    throw new Error("Snapshot backup requires distinct source and destination files");
  const sqlite = new DatabaseSync(source, { readOnly: true });
  try {
    sqlite.exec("PRAGMA busy_timeout=5000; BEGIN");
    // Pin one committed snapshot, including WAL, so concurrent writers cannot restart the copy.
    sqlite.prepare("PRAGMA schema_version").get();
    await backup(sqlite, destination, { rate: 4096 });
  } finally {
    sqlite.close();
  }
}
