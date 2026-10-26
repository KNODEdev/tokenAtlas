/**
 * Rewrites a store's unsuffixed gauge journal (written before segmentation, every reading three
 * times over) into compact month files and retires the original.
 *
 *   bun scripts/dev/journal-compact-legacy.ts --store <gauges/MACHINE-LOGIN> --backup <dir> [--apply]
 *
 * Without --apply nothing is written. Readings cannot be measured again, so: only the store's
 * owner may run it, every rewritten line is expanded again and compared with the original before
 * anything is published, the month file is complete before it gets its name, the original is
 * moved to a backup outside the archive rather than deleted, and the store records what replaced
 * it (journal-superseded.json) so a bookmark of the vanished file is not read as a lost source.
 *
 * A rewritten line gets a new entry id derived from the old one: a receipt binds an entry id to
 * its exact text, so keeping the id would read as tampering wherever the old line was ingested.
 * The facts are unchanged (same counter ids), so such a database accepts nothing new. Lines
 * without a canonical probe are carried over verbatim.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/config/canonical-json";
import { validateCanonicalProbe, type CanonicalProbe } from "../../src/db/probe-facts";
import { compactProbeBase, compactProbeLine, expandCompactProbe, isCompactProbeRecord } from "../../src/providers/core/journal-compact";
import { JOURNAL_KINDS, SUPERSEDED_JOURNALS_FILE, supersededJournals, type JournalKind, type SupersededJournal } from "../../src/providers/core/journal-files";

export interface LegacyJournalReport {
  kind: JournalKind; lines: number; compacted: number; references: number; verbatim: number;
  bytesBefore: number; bytesAfter: number; into: string[]; applied: boolean;
}
export interface LegacyJournalOptions { storeRoot: string; backupRoot: string; ownStore: string; apply: boolean; now?: () => Date; quietMinutes?: number }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** A stable version 4 shaped id, so a repeated conversion produces the same lines. */
function derivedEntryId(entryId: string): string {
  const h = createHash("sha256").update(`${entryId}:compact`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
async function* journalLines(file: string): AsyncGenerator<string> {
  for await (const line of readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity })) if (line.trim()) yield line;
}
function writeDurably(file: string, text: string): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function convertKind(kind: JournalKind, options: LegacyJournalOptions): Promise<LegacyJournalReport | null> {
  const legacy = path.join(options.storeRoot, kind);
  if (!fs.existsSync(legacy)) return null;
  const now = (options.now ?? (() => new Date()))();
  const before = fs.statSync(legacy);
  // A build from before segmentation still appends here; converting under it would lose its next lines.
  const quietMinutes = options.quietMinutes ?? 30;
  // Zero explicitly disables the wait, even when the filesystem clock has finer precision than Date.
  if (options.apply && quietMinutes > 0 && now.getTime() - before.mtimeMs < quietMinutes * 60_000) throw new Error(`${kind} was written recently; stop every older build first`);
  const months = new Map<string, string[]>();
  const bases = new Map<string, { fact: CanonicalProbe; day: string }>();
  const report: LegacyJournalReport = { kind, lines: 0, compacted: 0, references: 0, verbatim: 0, bytesBefore: before.size, bytesAfter: 0, into: [], applied: false };
  for await (const line of journalLines(legacy)) {
    report.lines += 1;
    const raw: unknown = JSON.parse(line);
    if (!isRecord(raw)) throw new Error(`${kind}: line ${report.lines} is not a record`);
    let written = typeof raw.ts === "string" ? raw.ts : "", out = line;
    if (raw.canonical_probe !== undefined && typeof raw.journal_entry_id === "string") {
      const fact = validateCanonicalProbe(raw.canonical_probe, raw);
      written = fact.header.recorded_at;
      const day = written.slice(0, 10), key = canonicalJson([fact.header.machine, fact.header.login, fact.header.subject, fact.discriminator]);
      const prior = bases.get(key);
      const compact = compactProbeLine(derivedEntryId(raw.journal_entry_id), fact, prior && prior.day === day ? prior.fact : null);
      if (compact.full) bases.set(key, { fact, day }); else report.references += 1;
      report.compacted += 1; out = compact.line;
    } else report.verbatim += 1;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(written)) throw new Error(`${kind}: line ${report.lines} has no usable time`);
    const target = `${kind.slice(0, -".jsonl".length)}.${written.slice(0, 7)}.jsonl`;
    const month = months.get(target) ?? [];
    if (!month.length) months.set(target, month);
    month.push(out);
  }
  // Proof before publication: what the new files expand to, against the original, line by line.
  const expected = new Map<string, number>(), accepted = new Map<string, CanonicalProbe>();
  const expanded = new Map<string, string[]>();
  for (const [target, lines] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
    expanded.set(target, lines.map(text => {
      const record = JSON.parse(text) as Record<string, unknown>;
      if (!isCompactProbeRecord(record)) return text;
      const baseId = compactProbeBase(record);
      const { fact } = expandCompactProbe(record, baseId ? accepted.get(baseId) ?? null : null);
      accepted.set(fact.counter_id, fact);
      return canonicalJson(fact);
    }));
  }
  for await (const line of journalLines(legacy)) {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const canonical = raw.canonical_probe !== undefined && typeof raw.journal_entry_id === "string";
    const written = canonical ? (raw.canonical_probe as CanonicalProbe).header.recorded_at : String(raw.ts);
    const target = `${kind.slice(0, -".jsonl".length)}.${written.slice(0, 7)}.jsonl`, index = expected.get(target) ?? 0;
    if (expanded.get(target)?.[index] !== (canonical ? canonicalJson(raw.canonical_probe) : line)) throw new Error(`${kind}: rewritten line ${index + 1} of ${target} does not reproduce the original`);
    expected.set(target, index + 1);
  }
  for (const [target, lines] of months) if (expected.get(target) !== lines.length) throw new Error(`${kind}: ${target} line count differs from the original`);
  const after = fs.statSync(legacy);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`${kind} changed during conversion`);
  report.into = [...months.keys()].sort();
  report.bytesAfter = [...months.values()].reduce((sum, lines) => sum + Buffer.byteLength(lines.join("\n") + "\n"), 0);
  // The rewrite is deterministic, so a month file an interrupted run already published is
  // recognised by its content; any other existing file is someone else's and is never merged into.
  const textOf = (target: string) => months.get(target)!.join("\n") + "\n";
  const published = new Set(report.into.filter(target => fs.existsSync(path.join(options.storeRoot, target))));
  for (const target of published) if (sha256(path.join(options.storeRoot, target)) !== createHash("sha256").update(textOf(target)).digest("hex"))
    throw new Error(`${target} already exists; merging into it is not supported`);
  if (!options.apply) return report;

  for (const target of report.into.filter(name => !published.has(name))) {
    const text = textOf(target), pending =path.join(options.storeRoot, `${target}.converting`);
    fs.rmSync(pending, { force: true });
    writeDurably(pending, text);
    if (sha256(pending) !== createHash("sha256").update(text).digest("hex")) throw new Error(`${target} did not read back as written`);
    fs.renameSync(pending, path.join(options.storeRoot, target));
  }
  const digest = sha256(legacy), backupDirectory = path.join(options.backupRoot, path.basename(options.storeRoot));
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backup = path.join(backupDirectory, `${kind}.${now.toISOString().replace(/[:.]/g, "-")}`);
  fs.copyFileSync(legacy, backup, fs.constants.COPYFILE_EXCL);
  if (sha256(backup) !== digest) throw new Error(`Backup of ${kind} does not match the original`);
  const record: SupersededJournal = { bytes: before.size, sha256: digest, lines: report.lines, into: report.into, superseded_at: now.toISOString() };
  const manifest = path.join(options.storeRoot, SUPERSEDED_JOURNALS_FILE), pendingManifest = `${manifest}.converting`;
  fs.rmSync(pendingManifest, { force: true });
  writeDurably(pendingManifest, JSON.stringify({ ...supersededJournals(options.storeRoot), [kind]: record }, null, 2) + "\n");
  fs.renameSync(pendingManifest, manifest);
  fs.unlinkSync(legacy);
  report.applied = true;
  return report;
}

export async function compactLegacyJournals(options: LegacyJournalOptions): Promise<LegacyJournalReport[]> {
  const storeRoot = path.resolve(options.storeRoot), backupRoot = path.resolve(options.backupRoot);
  if (path.basename(storeRoot) !== options.ownStore) throw new Error("Only the store's owner rewrites its journal");
  const relative = path.relative(path.dirname(path.dirname(storeRoot)), backupRoot);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("The backup must live outside the archive");
  const reports: LegacyJournalReport[] = [];
  for (const kind of JOURNAL_KINDS) {
    const report = await convertKind(kind, { ...options, storeRoot, backupRoot });
    if (report) reports.push(report);
  }
  return reports;
}

if (import.meta.main) {
  const value = (flag: string) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
  const storeRoot = value("--store"), backupRoot = value("--backup");
  if (!storeRoot || !backupRoot) { console.error("usage: --store <gauges/MACHINE-LOGIN> --backup <dir outside the archive> [--apply]"); process.exit(2); }
  const { PROFILE } = await import("../../src/config/paths");
  const reports = await compactLegacyJournals({ storeRoot, backupRoot, ownStore: PROFILE, apply: process.argv.includes("--apply") });
  for (const report of reports) console.log(JSON.stringify(report));
  if (!process.argv.includes("--apply")) console.log("Dry run: nothing was written. Repeat with --apply.");
}
