import fs from "node:fs";
import path from "node:path";
import { activeDatabasePath } from "../../src/db";

/** Probe scripts may read only a closed copy, including one with an empty WAL reader sidecar. */
export function frozenLedgerCopy(input: string) {
  const copy = fs.realpathSync(path.resolve(input));
  const live = activeDatabasePath();
  const liveIdentity = fs.existsSync(live) ? fs.realpathSync(live) : path.resolve(live);
  if (copy.toLowerCase() === liveIdentity.toLowerCase()) throw new Error("Pass a frozen copy, not the active database");
  const before = fs.statSync(copy);
  if (fs.existsSync(liveIdentity)) {
    const liveStat = fs.statSync(liveIdentity);
    if (before.ino !== 0 && before.ino === liveStat.ino && before.dev === liveStat.dev) {
      throw new Error("Pass a frozen copy, not a hard link to the active database");
    }
  }
  if (!before.isFile()) throw new Error("Frozen copy must be a regular file");
  const hasWriteJournal = () => [`${copy}-wal`, `${copy}-journal`].some(file => fs.existsSync(file) && fs.statSync(file).size > 0);
  if (hasWriteJournal()) throw new Error("Frozen copy has a write journal; prepare a closed, consistent copy first");
  return { copy, live, before, assertUnchanged() {
    const after = fs.statSync(copy);
    if (hasWriteJournal() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || before.ino !== after.ino || before.dev !== after.dev) throw new Error("Frozen copy changed during audit; evidence rejected");
  } };
}
