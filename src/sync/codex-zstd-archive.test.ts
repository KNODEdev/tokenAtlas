import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishArchiveFile, archivePublicationPaths } from "./archive-publication";
import { ensureArchiveIdentity } from "./archive-inventory";
import { isRecoverableArchiveSource } from "./archive-source-path";
import { selectRolloutRepresentation, withDecodedRollouts } from "../ingest/codex-rollout";

const initial = '{"type":"session_meta","payload":{"id":"test"}}\n';
const more = '{"type":"token_usage_record","payload":{"response_id":"r1","usage":{"input_tokens":100,"output_tokens":10}}}\n';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-zstd-archive-"));
  const archiveRoot = path.join(root, "OneDrive-copy"); fs.mkdirSync(archiveRoot); ensureArchiveIdentity(archiveRoot);
  const source = path.join(root, "original.jsonl"), plain = path.join(archiveRoot, "codex", "PC", "sessions", "rollout-test.jsonl");
  const options = { archiveRoot, localStateRoot: path.join(root, "local"), jsonl: true };
  const writeCompressed = (content: string) => fs.writeFileSync(`${source}.zst`, Bun.zstdCompressSync(content, { level: 3 }));
  const publish = (compressed = false) => publishArchiveFile(source + (compressed ? ".zst" : ""), plain + (compressed ? ".zst" : ""), options);
  const content = () => withDecodedRollouts([selectRolloutRepresentation(plain)], ([decoded]) => fs.readFileSync(decoded!, "utf8"));
  const state = () => JSON.parse(fs.readFileSync(archivePublicationPaths(archiveRoot, plain, options).state, "utf8"));
  return { root, archiveRoot, source, plain, options, writeCompressed, publish, content, state,
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test("archive codec transitions retain one accepted file and exact bytes; deleted originals do not prune it", () => {
  const f = fixture();
  try {
    expect(isRecoverableArchiveSource("codex/PC/sessions/a.jsonl.zst")).toBe(true);
    expect(isRecoverableArchiveSource("claude/PC/a.jsonl.zst")).toBe(true);
    fs.writeFileSync(f.source, initial + more); f.publish();
    f.writeCompressed(initial + more); expect(f.publish(true)).toBe("copied");
    expect(fs.existsSync(f.plain)).toBe(false); expect(f.content()).toBe(initial + more);
    expect(f.state().logicalBytes).toBe(Buffer.byteLength(initial + more));
    expect(f.publish(true)).toBe("unchanged");
    fs.writeFileSync(f.source, initial + more + '{"next":1}\n'); expect(f.publish()).toBe("copied");
    expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
    f.writeCompressed(initial); expect(f.publish(true)).toBe("unchanged");
    expect(f.content()).toBe(initial + more + '{"next":1}\n');
    fs.unlinkSync(f.source); fs.unlinkSync(`${f.source}.zst`);
    expect(f.content()).toBe(initial + more + '{"next":1}\n');
  } finally { f.close(); }
});

test("a missing compressed archive can recover from plain bytes, but a stale sibling cannot lower its checkpoint", () => {
  const f = fixture();
  try {
    f.writeCompressed(initial + more); f.publish(true); fs.unlinkSync(`${f.plain}.zst`);
    fs.writeFileSync(f.source, initial + more); expect(f.publish()).toBe("copied");
    expect(f.content()).toBe(initial + more);
    fs.unlinkSync(f.plain);
    f.writeCompressed(initial); fs.writeFileSync(`${f.plain}.zst`, fs.readFileSync(`${f.source}.zst`));
    const before = f.state(); expect(() => f.publish(true)).toThrow("cannot prove its accepted prefix");
    expect(f.state()).toEqual(before);
    f.writeCompressed(initial + more); expect(f.publish(true)).toBe("copied");
    expect(f.content()).toBe(initial + more);
  } finally { f.close(); }
});

test("corrupt compressed sources and incomplete JSONL cannot replace accepted history", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.source, initial + more); f.publish();
    for (const bytes of [Buffer.from("bad-frame"), Bun.zstdCompressSync('{"partial":')]) {
      fs.writeFileSync(`${f.source}.zst`, bytes);
      expect(() => f.publish(true)).toThrow();
      expect(f.content()).toBe(initial + more); expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
    }
    f.writeCompressed(initial + more.replace('"input_tokens":100', '"input_tokens":999'));
    expect(() => f.publish(true)).toThrow("conflict");
    expect(f.content()).toBe(initial + more);
  } finally { f.close(); }
});

test("an interrupted codec retirement leaves compatible siblings; restart completes without losing bytes", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.source, initial + more); f.publish(); f.writeCompressed(initial + more);
    const unlink = fs.unlinkSync.bind(fs);
    const stop = spyOn(fs, "unlinkSync").mockImplementation((file => {
      if (String(file) === f.plain) throw new Error("synthetic interruption before retirement");
      return unlink(file);
    }) as typeof fs.unlinkSync);
    try { expect(() => f.publish(true)).toThrow("synthetic interruption"); }
    finally { stop.mockRestore(); }
    expect(fs.existsSync(f.plain)).toBe(true); expect(fs.existsSync(`${f.plain}.zst`)).toBe(true);
    expect(f.content()).toBe(initial + more);
    expect(f.publish(true)).toBe("copied"); expect(fs.existsSync(f.plain)).toBe(false);
    expect(f.content()).toBe(initial + more);
  } finally { f.close(); }
});

test("source and destination changes after decoded verification are fenced before compressed replacement", () => {
  for (const changed of ["source", "destination"] as const) {
    const f = fixture();
    try {
      fs.writeFileSync(f.source, initial + more); f.publish(); f.writeCompressed(initial + more);
      const open = fs.openSync.bind(fs); let reads = 0;
      const stop = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
        // The first open of the compressed source hashes it after decoded verification.
        if (String(file) === `${f.source}.zst` && reads++ === 0) {
          if (changed === "source") f.writeCompressed(initial);
          else fs.writeFileSync(f.plain, initial + more + '{"cloud":1}\n');
        }
        return Reflect.apply(open, fs, [file, ...args]);
      }) as typeof fs.openSync);
      try { expect(() => f.publish(true)).toThrow("changed"); }
      finally { stop.mockRestore(); }
      if (changed === "source") expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
      expect(fs.readFileSync(f.plain, "utf8")).toContain(more);
      if (changed === "destination") expect(fs.readFileSync(f.plain, "utf8")).toContain('"cloud":1');
    } finally { f.close(); }
  }
});

test("a compressed destination changed after decoding keeps the cloud append instead of overwriting it", () => {
  const f = fixture();
  try {
    f.writeCompressed(initial + more); f.publish(true);
    f.writeCompressed(initial + more + '{"owner":1}\n');
    const cloud = initial + more + '{"owner":1}\n{"cloud":1}\n';
    const open = fs.openSync.bind(fs); let changed = false;
    const stop = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file) === `${f.source}.zst` && !changed) {
        changed = true; fs.writeFileSync(`${f.plain}.zst`, Bun.zstdCompressSync(cloud));
      }
      return Reflect.apply(open, fs, [file, ...args]);
    }) as typeof fs.openSync);
    try { expect(() => f.publish(true)).toThrow("changed"); }
    finally { stop.mockRestore(); }
    expect(f.content()).toBe(cloud);
  } finally { f.close(); }
});
