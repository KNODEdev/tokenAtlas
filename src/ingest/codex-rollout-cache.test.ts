import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { withDecodedRollouts, withRolloutDecodeCache } from "./codex-rollout";
import { fileStamp } from "../sync/jsonl-inspection";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-cache-test-"));
  const file = path.join(root, "one.jsonl.zst"), sibling = path.join(root, "two.jsonl.zst");
  const storage = { databasePath: path.join(root, "copy.sqlite"), env: {
    ...process.env, TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_CONFIG: path.join(root, "config"),
    TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_TEMP_DIR: path.join(root, "scratch"),
  } };
  const write = (value: number) => {
    fs.writeFileSync(file, Bun.zstdCompressSync(`{"value":${value}}\n`));
    fs.utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
  };
  write(1);
  const read = (input = file) => withDecodedRollouts([input], ([decoded]) => ({
    file: decoded!, text: fs.readFileSync(decoded!, "utf8"),
  }), false, storage);
  const spawn = childProcess.spawnSync;
  let decodes = 0;
  const hook = spyOn(childProcess, "spawnSync").mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (args[1]?.[0] === "--decode-rollout") decodes++;
    return spawn(...args);
  }) as typeof spawn);
  return { file, sibling, storage, write, read, count: () => decodes,
    close() { hook.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("one compression operation shares identical decoded bytes across publication paths and disposes scratch", () => {
  const f = fixture(); let decoded = "";
  try {
    withRolloutDecodeCache(() => {
      const first = f.read(); decoded = first.file;
      fs.copyFileSync(f.file, f.sibling);
      const published = f.read(f.sibling);
      expect(published).toEqual(first);
      expect(withRolloutDecodeCache(() => f.read())).toEqual(first);
      expect(f.count()).toBe(1);
      expect(fs.existsSync(decoded)).toBe(true);
    });
    expect(fs.existsSync(decoded)).toBe(false);
    withRolloutDecodeCache(() => expect(f.read().text).toBe('{"value":1}\n'));
    expect(f.count()).toBe(2);
  } finally { f.close(); }
});

test("changed compressed bytes with unchanged size and mtime require another native decode", () => {
  const f = fixture();
  try {
    withRolloutDecodeCache(() => {
      expect(f.read().text).toBe('{"value":1}\n');
      const before = fileStamp(f.file);
      f.write(2);
      expect(fileStamp(f.file)).toBe(before);
      expect(f.read().text).toBe('{"value":2}\n');
      expect(f.count()).toBe(2);
    });
  } finally { f.close(); }
});

test("same-stamp mutation during consumption fails its byte fence and removes scratch", () => {
  const f = fixture(); let decoded = "";
  try {
    expect(() => withRolloutDecodeCache(() => withDecodedRollouts([f.file], ([input]) => {
      decoded = input!; const before = fileStamp(f.file);
      f.write(2); expect(fileStamp(f.file)).toBe(before);
    }, false, f.storage))).toThrow("bytes changed while reading");
    expect(fs.existsSync(decoded)).toBe(false);
  } finally { f.close(); }
});

test("failed consumption disposes scratch and does not carry a decoded result into another operation", () => {
  const f = fixture(); let decoded = "";
  try {
    expect(() => withRolloutDecodeCache(() => {
      decoded = f.read().file; throw new Error("synthetic publication failure");
    })).toThrow("synthetic publication failure");
    expect(fs.existsSync(decoded)).toBe(false);
    withRolloutDecodeCache(() => expect(f.read().text).toBe('{"value":1}\n'));
    expect(f.count()).toBe(2);
  } finally { f.close(); }
});

test("corrupted compressed replacement cannot reuse an earlier successful decode", () => {
  const f = fixture();
  try {
    expect(() => withRolloutDecodeCache(() => {
      f.read(); const original = fs.readFileSync(f.file);
      original.fill(0); fs.writeFileSync(f.file, original);
      fs.utimesSync(f.file, new Date("2020-01-01"), new Date("2020-01-01"));
      f.read();
    })).toThrow("Cannot decode archive source");
    expect(f.count()).toBe(2);
  } finally { f.close(); }
});
