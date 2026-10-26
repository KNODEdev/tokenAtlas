import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { ensureArchiveIdentity } from "./archive-inventory";
import { ArchivePublicationConflictError, publishArchiveFile } from "./archive-publication";
import { readOriginalRecord } from "./archive-originals";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });
const lines = (count: number) => Array.from({ length: count }, (_, index) => JSON.stringify({ record: index })).join("\n") + "\n";
// Times a double holds exactly, so they can be set and compared on every file system.
const at = (file: string, seconds: number) => fs.utimesSync(file, seconds, seconds);
const mtime = (file: string) => fs.statSync(file, { bigint: true }).mtimeNs;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-originals-"));
  roots.push(root);
  const archiveRoot = path.join(root, "archive"), localStateRoot = path.join(root, "local-state");
  const source = path.join(root, "provider", "session.jsonl"), destination = path.join(archiveRoot, "claude", "machine", "project", "session.jsonl");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(archiveRoot);
  ensureArchiveIdentity(archiveRoot);
  const options = { archiveRoot, localStateRoot, jsonl: true };
  return { root, archiveRoot, localStateRoot, source, destination, publish: () => publishArchiveFile(source, destination, options),
    clearLocalState: () => fs.rmSync(localStateRoot, { recursive: true, force: true }),
    manifest: path.join(archiveRoot, ".archive-inventory", "originals", "claude", "machine", "project", "files.json") };
}
/** Files opened per path while `work` runs. */
function opens(work: () => unknown): Map<string, number> {
  const counts = new Map<string, number>(), original = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    const key = path.resolve(String(file));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof fs.openSync);
  try { work(); } finally { spy.mockRestore(); }
  return counts;
}
const reads = (f: ReturnType<typeof fixture>, counts: Map<string, number>) =>
  [counts.get(path.resolve(f.source)) ?? 0, counts.get(path.resolve(f.destination)) ?? 0];

test("a verified copy is recorded in the archive; a copy pass without local state then reads no file and never touches the copy", () => {
  const f = fixture();
  fs.writeFileSync(f.source, lines(3)); at(f.source, 1_790_000_000.25);
  expect(f.publish()).toBe("copied");
  const copyTime = mtime(f.destination);
  expect(readOriginalRecord(f.archiveRoot, f.destination)).toMatchObject({ source: path.resolve(f.source),
    bytes: Buffer.byteLength(lines(3)), mtimeNs: mtime(f.source).toString(), copyBytes: Buffer.byteLength(lines(3)) });
  expect(fs.existsSync(f.manifest)).toBe(true);
  f.clearLocalState();
  expect(reads(f, opens(() => expect(f.publish()).toBe("unchanged")))).toEqual([0, 0]);
  expect(mtime(f.destination)).toBe(copyTime);
  // The pass wrote local state from the record: later passes and appends carry on as usual.
  expect(reads(f, opens(() => expect(f.publish()).toBe("unchanged")))).toEqual([0, 0]);
});

test("an appended original is read and only its new records appended, then recorded with its new size and time", () => {
  const f = fixture();
  fs.writeFileSync(f.source, lines(3)); at(f.source, 1_790_000_000.25);
  expect(f.publish()).toBe("copied");
  f.clearLocalState();
  fs.appendFileSync(f.source, JSON.stringify({ record: 3 }) + "\n"); at(f.source, 1_790_000_100.5);
  const counts = opens(() => expect(f.publish()).toBe("copied"));
  expect(reads(f, counts).every(count => count > 0)).toBe(true);
  expect(fs.readFileSync(f.destination, "utf8")).toBe(lines(4));
  expect(readOriginalRecord(f.archiveRoot, f.destination)).toMatchObject({ bytes: Buffer.byteLength(lines(4)), mtimeNs: mtime(f.source).toString() });
});

test("a record is written only after the bytes are confirmed equal", () => {
  const f = fixture();
  fs.writeFileSync(f.source, lines(3).replace('"record":1', '"record":9')); at(f.source, 1_790_000_000.25);
  fs.mkdirSync(path.dirname(f.destination), { recursive: true });
  fs.writeFileSync(f.destination, lines(3));
  expect(() => f.publish()).toThrow(ArchivePublicationConflictError);
  expect(readOriginalRecord(f.archiveRoot, f.destination)).toBeNull();
  // An incomplete last record is not the whole original: nothing is recorded until it completes.
  const g = fixture();
  fs.writeFileSync(g.source, lines(2) + '{"record":'); at(g.source, 1_790_000_000.25);
  expect(g.publish()).toBe("copied");
  expect(readOriginalRecord(g.archiveRoot, g.destination)).toBeNull();
});

test("whole-second times prove nothing: such a copy is read, and a diverging one is kept as a conflict", () => {
  const f = fixture();
  fs.writeFileSync(f.source, lines(3)); at(f.source, 1_790_000_000);
  expect(f.publish()).toBe("copied");
  f.clearLocalState();
  // Same size and time as recorded, other bytes: only a read can tell.
  fs.writeFileSync(f.source, lines(3).replace('"record":1', '"record":9')); at(f.source, 1_790_000_000);
  expect(() => f.publish()).toThrow(ArchivePublicationConflictError);
  expect(fs.readFileSync(f.destination, "utf8")).toBe(lines(3));
});

test("a missing or unreadable manifest only means the files are read again", () => {
  const f = fixture();
  fs.writeFileSync(f.source, lines(3)); at(f.source, 1_790_000_000.25);
  expect(f.publish()).toBe("copied");
  f.clearLocalState();
  fs.writeFileSync(f.manifest, "{not json");
  expect(reads(f, opens(() => expect(f.publish()).toBe("unchanged"))).every(count => count > 0)).toBe(true);
  expect(readOriginalRecord(f.archiveRoot, f.destination)).not.toBeNull();
  f.clearLocalState(); fs.rmSync(path.join(f.archiveRoot, ".archive-inventory", "originals"), { recursive: true });
  expect(f.publish()).toBe("unchanged");
  expect(readOriginalRecord(f.archiveRoot, f.destination)).not.toBeNull();
});
