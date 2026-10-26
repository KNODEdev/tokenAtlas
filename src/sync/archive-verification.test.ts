import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { ensureArchiveIdentity } from "./archive-inventory";
import { ArchivePublicationConflictError, publishArchiveFile } from "./archive-publication";
import { readOriginalRecord } from "./archive-originals";
import { advanceArchiveVerification } from "./archive-verification";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });
// Times a double holds exactly, so they can be set on every file system.
const at = (file: string, seconds: number) => fs.utimesSync(file, seconds, seconds);

test("background verification reads copies accepted by their record; a differing copy loses the record and is compared next", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-verification-"));
  roots.push(root);
  const archiveRoot = path.join(root, "archive"), localStateRoot = path.join(root, "local-state");
  const source = path.join(root, "provider", "project"), destination = path.join(archiveRoot, "claude", "machine", "project");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(archiveRoot);
  ensureArchiveIdentity(archiveRoot);
  const publish = (name: string) => publishArchiveFile(path.join(source, name), path.join(destination, name), { archiveRoot, localStateRoot, jsonl: true });
  for (const name of ["a.jsonl", "b.jsonl", "c.jsonl"]) {
    fs.writeFileSync(path.join(source, name), `{"${name[0]}":1}\n`); at(path.join(source, name), 1_790_000_000.25);
    expect(publish(name)).toBe("copied");
  }
  // b's copy changes behind the archive's back with the same size; c's original moved on, so c is not accepted by its record.
  fs.writeFileSync(path.join(destination, "b.jsonl"), '{"b":2}\n');
  fs.appendFileSync(path.join(source, "c.jsonl"), '{"c":2}\n');
  const bTime = fs.statSync(path.join(destination, "b.jsonl"), { bigint: true }).mtimeNs;
  let clock = 1_800_000_000_000;
  const options = { archiveRoot, localStateRoot, roots: () => [{ source, destination }], budgetMs: 0, now: () => clock };
  const turns = [advanceArchiveVerification(options), advanceArchiveVerification(options), advanceArchiveVerification(options)];
  // One file per turn at a zero budget, with the cycle's progress.
  expect(turns.map(({ checked, done, total }) => ({ checked, done, total }))).toEqual([
    { checked: 1, done: 1, total: 3 }, { checked: 1, done: 2, total: 3 }, { checked: 0, done: 3, total: 3 }]);
  expect(turns.flatMap(turn => turn.differing)).toEqual([path.join(destination, "b.jsonl")]);
  expect(readOriginalRecord(archiveRoot, path.join(destination, "a.jsonl"))).not.toBeNull();
  expect(readOriginalRecord(archiveRoot, path.join(destination, "b.jsonl"))).toBeNull();
  // The archive file itself is not touched.
  expect(fs.statSync(path.join(destination, "b.jsonl"), { bigint: true }).mtimeNs).toBe(bTime);
  expect(fs.readFileSync(path.join(destination, "b.jsonl"), "utf8")).toBe('{"b":2}\n');
  // A finished cycle rests; a day after it began the archive is listed again.
  expect(advanceArchiveVerification(options)).toEqual({ checked: 0, differing: [], done: 0, total: 0 });
  clock += 24 * 3600_000;
  expect(advanceArchiveVerification(options)).toMatchObject({ done: 1, total: 3 });
  // Without local state the next copy pass reads b and keeps the copy, with the original as conflict evidence.
  fs.rmSync(localStateRoot, { recursive: true, force: true });
  expect(() => publish("b.jsonl")).toThrow(ArchivePublicationConflictError);
});
