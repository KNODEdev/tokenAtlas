import fs from "node:fs";
import path from "node:path";
import { archiveLocalStateDirectory, atomicLocalWrite, type ArchiveLocalStateOptions } from "./archive-local-state";
import { copyEqualsOriginal } from "./archive-publication";
import { forgetOriginal, originalUnchanged } from "./archive-originals";

/**
 * Slow background re-verification of the archive copies that a copy pass without local state
 * accepts by their original's recorded size and time alone (archive-originals.ts). In bounded
 * turns each such copy is read side by side with its original. A copy whose bytes differ loses
 * its record, so the next copy pass reads both files and the publication rules decide: the longer
 * copy is kept, a divergence is kept as a conflict. Archive files themselves are never touched. The archive is listed once per cycle into local state and then walked by a cursor;
 * a new cycle starts a day after the previous one began.
 */
export interface ArchiveCopyRoot { source: string; destination: string }
export interface ArchiveVerificationTurn {
  /** Copies read side by side in this turn. */
  checked: number;
  /** Copies whose bytes differ from their original; they lose their record. */
  differing: string[];
  /** Files of the current cycle handled, of all; zero of zero when no cycle is running. */
  done: number; total: number;
}
export interface ArchiveVerificationOptions extends ArchiveLocalStateOptions {
  archiveRoot: string;
  roots: () => ArchiveCopyRoot[];
  budgetMs?: number;
  now?: () => number;
}

const CYCLE_MS = 24 * 3600_000;
// Archive artefacts beside the copies, never copies of an original.
const ARTEFACT = /\.(conflict-[0-9a-f]+\.source|superseded-[0-9a-f]+\.reading)$|\.tmp-/;

interface Cycle { schema: 1; startedAt: number; cursor: number; total: number }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if (missing(error)) return null; throw error; }
}

function listPairs(roots: ArchiveCopyRoot[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const walk = (source: string, destination: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(destination, { withFileTypes: true }); }
    catch (error) { if (missing(error)) return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const from = path.join(source, entry.name), to = path.join(destination, entry.name);
      if (entry.isDirectory()) walk(from, to);
      else if (entry.isFile() && !ARTEFACT.test(entry.name)) pairs.push([from, to]);
    }
  };
  for (const root of roots) walk(root.source, root.destination);
  return pairs;
}

/** One bounded turn: at least one file, then as many as fit `budgetMs` (default 250 ms). */
export function advanceArchiveVerification(options: ArchiveVerificationOptions): ArchiveVerificationTurn {
  const now = options.now ?? Date.now;
  const directory = path.join(archiveLocalStateDirectory(options.archiveRoot, options), "verification");
  const cycleFile = path.join(directory, "cycle.json"), listFile = path.join(directory, "pairs.json");
  let cycle = readJson<Cycle>(cycleFile);
  const finished = !!cycle && cycle.cursor >= cycle.total;
  if (!cycle || finished && now() - cycle.startedAt >= CYCLE_MS) {
    const pairs = listPairs(options.roots());
    atomicLocalWrite(listFile, JSON.stringify(pairs));
    cycle = { schema: 1, startedAt: now(), cursor: 0, total: pairs.length };
    atomicLocalWrite(cycleFile, JSON.stringify(cycle));
  }
  const turn: ArchiveVerificationTurn = { checked: 0, differing: [], done: cycle.cursor, total: cycle.total };
  if (cycle.cursor >= cycle.total) return { ...turn, done: 0, total: 0 };
  const pairs = readJson<Array<[string, string]>>(listFile) ?? [];
  const deadline = performance.now() + (options.budgetMs ?? 250);
  do {
    const [source, destination] = pairs[cycle.cursor] ?? [];
    cycle.cursor++;
    if (!source || !destination) continue;
    try {
      if (!originalUnchanged(options.archiveRoot, source, destination)) continue;
      turn.checked++;
      if (copyEqualsOriginal(source, destination)) continue;
      turn.differing.push(destination);
      forgetOriginal(options.archiveRoot, destination, options);
    } catch (error) {
      // A file that changes or disappears while it is read is the next copy pass's to handle.
      if (!missing(error) && !String(error).includes("changed while reading")) throw error;
    }
  } while (cycle.cursor < cycle.total && performance.now() < deadline);
  atomicLocalWrite(cycleFile, JSON.stringify(cycle));
  return { ...turn, done: cycle.cursor, total: cycle.total };
}
