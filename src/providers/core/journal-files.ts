import fs from "node:fs";

/**
 * Names of the gauge journal files inside one machine's store (`gauges/<MACHINE>-<LOGIN>/`).
 *
 * A journal kind is written as daily segments named after the UTC day of the WRITE, so a closed
 * day never changes again and a cloud client uploads only today's small file instead of the
 * whole history. Closed days are later gathered into one file per month. The unsuffixed file is
 * the journal as written before segmentation; it stays readable and is never appended again.
 * Every entry carries its own timestamp and entry id, so the file an entry sits in never
 * decides its meaning and a receiver deduplicates an entry met in two files.
 */
export const PROBE_JOURNAL_FILE = "probe_windows.jsonl";
export const OBSERVATION_JOURNAL_FILE = "account_observations.jsonl";
export type JournalKind = typeof PROBE_JOURNAL_FILE | typeof OBSERVATION_JOURNAL_FILE;
export const JOURNAL_KINDS = [PROBE_JOURNAL_FILE, OBSERVATION_JOURNAL_FILE] as const;

const SEGMENT = /^(probe_windows|account_observations)(?:\.(\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?))?\.jsonl$/;
/** The same names as a path suffix, for archive path classification. */
export const JOURNAL_FILE_PATH = /(?:^|\/)(?:probe_windows|account_observations)(?:\.\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?\.jsonl$/;

/** The kind a journal file belongs to, or null for any other file name. */
export function journalKindOf(name: string): JournalKind | null {
  const match = SEGMENT.exec(name);
  return match ? `${match[1]}.jsonl` as JournalKind : null;
}

/** Today's segment of a kind; the day is the UTC day of the write, not of the measurement. */
export function dailyJournalFile(kind: JournalKind, now: Date): string {
  return `${kind.slice(0, -".jsonl".length)}.${now.toISOString().slice(0, 10)}.jsonl`;
}

/** A store's files of one kind, in reading order. A missing store has none. */
export function listJournalFiles(storeRoot: string, kind: JournalKind): string[] {
  let names: string[];
  try { names = fs.readdirSync(storeRoot); } catch { return []; }
  return names.filter(name => journalKindOf(name) === kind).sort(compareJournalFiles);
}

/**
 * Reading order inside one store: the unsuffixed journal, then segments by period. A month file
 * holds days older than any daily segment still beside it, and sorts before them.
 */
export function compareJournalFiles(left: string, right: string): number {
  const period = (name: string) => SEGMENT.exec(name)?.[2] ?? "";
  return period(left).localeCompare(period(right)) || left.localeCompare(right);
}

/**
 * Written into a store by its owner when a journal file was rewritten into other files of the
 * same kind and then removed (scripts/dev/journal-compact-legacy.ts). A bookmark may outlive
 * such a file; this record is what tells a deliberate replacement from a lost source.
 */
export const SUPERSEDED_JOURNALS_FILE = "journal-superseded.json";
export interface SupersededJournal { bytes: number; sha256: string; lines: number; into: string[]; superseded_at: string }

/** Superseded journal files of a store by name; a missing or unreadable record supersedes nothing. */
export function supersededJournals(storeRoot: string): Record<string, SupersededJournal> {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(`${storeRoot}/${SUPERSEDED_JOURNALS_FILE}`, "utf8")); } catch { return {}; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, SupersededJournal>)
    .filter(([name, record]) => journalKindOf(name) !== null && Array.isArray(record?.into) && record.into.length > 0
      && record.into.every(target => typeof target === "string" && journalKindOf(target) === journalKindOf(name))));
}
