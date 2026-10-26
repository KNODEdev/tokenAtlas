import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as childProcess from "node:child_process";
import { removeTestFixture } from "../test-cleanup";
import { ensureArchiveIdentity } from "./archive-inventory";
import { archivePublicationPaths, publishArchiveFile } from "./archive-publication";
import { readOriginalRecord } from "./archive-originals";
import { acquireArchiveWriterFence, ArchiveWritesPausedError, withArchiveWriter } from "./archive-writers";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });
const body = '{"one":1}\n{"two":2}\n';

function fixture(compressed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-publication-noop-"));
  roots.push(root);
  const archiveRoot = path.join(root, "archive"), localStateRoot = path.join(root, "state");
  const source = path.join(root, compressed ? "source.jsonl.zst" : "source.jsonl");
  const destination = path.join(archiveRoot, "claude", "fixture", compressed ? "session.jsonl.zst" : "session.jsonl");
  fs.mkdirSync(archiveRoot); ensureArchiveIdentity(archiveRoot);
  fs.writeFileSync(source, compressed ? Bun.zstdCompressSync(body) : body);
  const options = { archiveRoot, localStateRoot, jsonl: true };
  const publish = () => publishArchiveFile(source, destination, options);
  expect(publish()).toBe("copied");
  return { root, archiveRoot, source, destination, options, publish };
}

function observe(f: ReturnType<typeof fixture>, work: () => unknown) {
  let payloadReads = 0, syncs = 0;
  const open = fs.openSync, sync = fs.fsyncSync;
  const paths = new Set([f.source, f.destination, `${f.destination}.zst`]);
  const reads = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (paths.has(String(file))) payloadReads++;
    return Reflect.apply(open, fs, [file, ...args]);
  }) as typeof fs.openSync);
  const writes = spyOn(fs, "fsyncSync").mockImplementation(fd => { syncs++; sync(fd); });
  try { work(); } finally { reads.mockRestore(); writes.mockRestore(); }
  return { payloadReads, syncs };
}

for (const compressed of [false, true]) {
  test(`${compressed ? "compressed" : "plain"} unchanged publication reads no payload and performs no durable write`, () => {
    const f = fixture(compressed), accepted = fs.readFileSync(f.destination), at = fs.statSync(f.destination).mtimeMs;
    expect(observe(f, () => expect(f.publish()).toBe("unchanged"))).toEqual({ payloadReads: 0, syncs: 0 });
    expect(fs.readFileSync(f.destination)).toEqual(accepted);
    expect(fs.statSync(f.destination).mtimeMs).toBe(at);
  });
}

test("a plain original against a checkpointed compressed archive also needs no durable write", () => {
  const f = fixture();
  fs.writeFileSync(`${f.destination}.zst`, Bun.zstdCompressSync(body)); fs.unlinkSync(f.destination);
  expect(f.publish()).toBe("unchanged");
  expect(observe(f, () => expect(f.publish()).toBe("unchanged"))).toEqual({ payloadReads: 0, syncs: 0 });
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(Bun.zstdDecompressSync(fs.readFileSync(`${f.destination}.zst`)).toString()).toBe(body);
  expect(() => publishArchiveFile(f.source, `${f.destination}.zst`, f.options)).toThrow("keep the source codec");
});

test("cold checkpoints for identical compacted history validate one transcript and survive restart", () => {
  const f = fixture(), content = body + Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, payload: "x".repeat(1000) }) + "\n").join("");
  fs.writeFileSync(f.source, content);
  fs.writeFileSync(`${f.destination}.zst`, Bun.zstdCompressSync(content)); fs.unlinkSync(f.destination);
  const checkpoint = archivePublicationPaths(f.options.archiveRoot, f.destination, f.options).state;
  fs.unlinkSync(checkpoint);
  const compressed = fs.readFileSync(`${f.destination}.zst`), at = fs.statSync(`${f.destination}.zst`).mtimeMs;
  const parse = JSON.parse;
  let parsedRecords = 0;
  const spy = spyOn(JSON, "parse").mockImplementation((text, ...args) => {
    if (typeof text === "string" && text.includes('"payload":')) parsedRecords++;
    return Reflect.apply(parse, JSON, [text, ...args]);
  });
  try { expect(f.publish()).toBe("unchanged"); } finally { spy.mockRestore(); }
  expect(parsedRecords).toBe(200);
  expect(fs.readFileSync(`${f.destination}.zst`)).toEqual(compressed);
  expect(fs.statSync(`${f.destination}.zst`).mtimeMs).toBe(at);
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(JSON.parse(fs.readFileSync(checkpoint, "utf8")).logicalBytes).toBe(Buffer.byteLength(content));
  expect(observe(f, () => expect(f.publish()).toBe("unchanged"))).toEqual({ payloadReads: 0, syncs: 0 });
  fs.appendFileSync(f.source, '{"appended":1}\n');
  expect(f.publish()).toBe("copied");
  expect(fs.readFileSync(f.destination, "utf8")).toBe(content + '{"appended":1}\n');
});

test("identical malformed compacted history cannot acquire a trusted cold checkpoint", () => {
  const f = fixture(), malformed = '{"ok":1}\n{broken}\n';
  fs.writeFileSync(f.source, malformed);
  fs.writeFileSync(`${f.destination}.zst`, Bun.zstdCompressSync(malformed)); fs.unlinkSync(f.destination);
  const checkpoint = archivePublicationPaths(f.archiveRoot, f.destination, f.options).state;
  fs.unlinkSync(checkpoint);
  expect(f.publish).toThrow("Invalid JSONL record");
  expect(fs.existsSync(checkpoint)).toBe(false);
  expect(Bun.zstdDecompressSync(fs.readFileSync(`${f.destination}.zst`)).toString()).toBe(malformed);
});

test("identical compressed source and archive decode once when recovering a cold checkpoint", () => {
  const f = fixture(true), checkpoint = archivePublicationPaths(f.archiveRoot, f.destination, f.options).state;
  fs.unlinkSync(checkpoint);
  const spawn = childProcess.spawnSync;
  let decodes = 0;
  const spy = spyOn(childProcess, "spawnSync").mockImplementation(((...args: Parameters<typeof spawn>) => {
    if ((args[1] as string[])?.[0] === "--decode-rollout") decodes++;
    return Reflect.apply(spawn, childProcess, args);
  }) as typeof spawn);
  try { expect(f.publish()).toBe("unchanged"); } finally { spy.mockRestore(); }
  expect(decodes).toBe(1);
  expect(observe(f, () => expect(f.publish()).toBe("unchanged"))).toEqual({ payloadReads: 0, syncs: 0 });
});

test("an explicit archive-source fence is checked even for otherwise unchanged bytes", () => {
  const f = fixture(true);
  expect(() => publishArchiveFile(f.source, f.destination, {
    ...f.options, expectedArchiveSource: { file: f.destination, stamp: "changed" },
  })).toThrow("Archive source changed before compression publication");
});

test("an unchanged publication still refuses an archive fenced for relocation", () => {
  const f = fixture(), fence = acquireArchiveWriterFence(f.archiveRoot, randomUUID());
  try { expect(f.publish).toThrow(ArchiveWritesPausedError); fence.assertDrained(); }
  finally { fence.release(); }
  expect(f.publish()).toBe("unchanged");
});

test("a previously admitted outer writer can drain through a later relocation fence", () => {
  const f = fixture();
  let fence: ReturnType<typeof acquireArchiveWriterFence> | undefined;
  try {
    withArchiveWriter(f.archiveRoot, () => {
      fence = acquireArchiveWriterFence(f.archiveRoot, randomUUID());
      expect(f.publish()).toBe("unchanged");
      expect(() => fence!.assertDrained()).toThrow("Archive writer still active");
    });
    fence!.assertDrained();
  } finally { fence?.release(); }
});

test("a destination changed during admission is checked again before returning unchanged", () => {
  const f = fixture(), exists = fs.existsSync, changed = body.replace('"one":1', '"one":9');
  let replaced = false;
  const hook = spyOn(fs, "existsSync").mockImplementation(file => {
    if (!replaced && String(file) === path.join(f.archiveRoot, ".archive-relocation-owner.json")) {
      replaced = true; fs.writeFileSync(f.destination, changed);
      fs.utimesSync(f.destination, new Date("2020-01-01"), new Date("2020-01-01"));
    }
    return exists(file);
  });
  try { expect(f.publish).toThrow("Unresolved archive source conflict"); }
  finally { hook.mockRestore(); }
  expect(replaced).toBe(true);
  expect(fs.readFileSync(f.destination, "utf8")).toBe(changed);
});

test("a new sibling must be reconciled even when the original checkpoint still matches", () => {
  const f = fixture();
  fs.writeFileSync(`${f.destination}.zst`, Bun.zstdCompressSync('{"different":1}\n'));
  expect(f.publish).toThrow("Conflicting archive representations");
  expect(fs.readFileSync(f.destination, "utf8")).toBe(body);
});

test("append and correction still use guarded publication and preserve accepted history", () => {
  const f = fixture();
  fs.appendFileSync(f.source, '{"three":3}\n');
  const append = observe(f, () => expect(f.publish()).toBe("copied"));
  expect(append.payloadReads).toBeGreaterThan(0); expect(append.syncs).toBeGreaterThan(0);
  const accepted = fs.readFileSync(f.destination, "utf8");
  fs.writeFileSync(f.source, accepted.replace('"one":1', '"one":9'));
  expect(f.publish).toThrow("Unresolved archive source conflict");
  expect(fs.readFileSync(f.destination, "utf8")).toBe(accepted);
});

test("a changed destination cannot reuse a matching source checkpoint", () => {
  const f = fixture(), changed = body.replace('"one":1', '"one":9');
  fs.writeFileSync(f.destination, changed);
  fs.utimesSync(f.destination, new Date("2020-01-01"), new Date("2020-01-01"));
  expect(f.publish).toThrow("Unresolved archive source conflict");
  expect(fs.readFileSync(f.destination, "utf8")).toBe(changed);
});

test("missing original manifests are repaired before taking the read-only path", () => {
  const f = fixture();
  const manifest = path.join(f.archiveRoot, ".archive-inventory", "originals", "claude", "fixture", "files.json");
  fs.unlinkSync(manifest);
  expect(observe(f, () => expect(f.publish()).toBe("unchanged")).syncs).toBeGreaterThan(0);
  expect(readOriginalRecord(f.archiveRoot, f.destination)).not.toBeNull();
  expect(observe(f, () => expect(f.publish()).toBe("unchanged"))).toEqual({ payloadReads: 0, syncs: 0 });
});

test("a fresh process retains the no-write path from its durable checkpoint", () => {
  const f = fixture(), module = path.resolve(import.meta.dir, "archive-publication.ts");
  const code = `import fs from "node:fs"; import {publishArchiveFile} from ${JSON.stringify(module)};
    const sync=fs.fsyncSync; let writes=0; fs.fsyncSync=(fd)=>{writes++;sync(fd)};
    const result=publishArchiveFile(${JSON.stringify(f.source)},${JSON.stringify(f.destination)},${JSON.stringify(f.options)});
    console.log(JSON.stringify({result,writes}));`;
  const child = Bun.spawnSync([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
  expect({ exit: child.exitCode, error: child.stderr.toString() }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(child.stdout.toString())).toEqual({ result: "unchanged", writes: 0 });
});
