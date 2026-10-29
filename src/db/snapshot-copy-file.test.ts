import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./sqlite";
import { copySnapshotDatabaseFile } from "./snapshot-copy-file";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-file-copy-"));
  roots.push(root);
  const source = path.join(root, "source.sqlite"), destination = path.join(root, "copy.sqlite");
  const writer = new Database(source, { create: true });
  writer.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained(rowid,value) VALUES(17,'original')");
  return { root, source, destination, writer };
}

test.each(["wal", "delete"])("copies exact file bytes in %s mode while blocking concurrent changes", (mode) => {
  const { source, destination, writer } = fixture();
  try {
    writer.exec(`PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0`);
    writer.exec("INSERT INTO retained(rowid,value) VALUES(31,'committed')");
    let expected: Buffer | undefined;
    copySnapshotDatabaseFile(source, destination, (totalBytes) => {
      expected = fs.readFileSync(source);
      expect(totalBytes).toBe(expected.length);
      writer.exec("PRAGMA busy_timeout=0");
      expect(() => writer.exec("INSERT INTO retained(value) VALUES('blocked')")).toThrow(/locked/);
    });
    expect(fs.readFileSync(destination).equals(expected!)).toBe(true);
    const copy = new Database(destination, { readonly: true });
    try {
      expect(copy.query("SELECT rowid,value FROM retained ORDER BY rowid").all()).toEqual([
        { rowid: 17, value: "original" }, { rowid: 31, value: "committed" },
      ]);
    } finally { copy.close(true); }
    writer.exec("INSERT INTO retained(value) VALUES('after copy')");
    expect(writer.query("SELECT COUNT(*) AS n FROM retained").get()).toEqual({ n: 3 });
  } finally { writer.close(true); }
});

test("refuses a file copy when a reader prevents checkpointing the full committed WAL", () => {
  const { source, destination, writer } = fixture();
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const reader = new Database(source, { readonly: true });
  try {
    reader.exec("BEGIN");
    reader.query("SELECT * FROM retained").all();
    writer.exec("INSERT INTO retained(value) VALUES('new WAL page')");
    expect(() => copySnapshotDatabaseFile(source, destination)).toThrow("completed WAL checkpoint");
    expect(fs.existsSync(destination)).toBe(false);
    writer.exec("INSERT INTO retained(value) VALUES('writer released')");
    expect(writer.query("SELECT COUNT(*) AS n FROM retained").get()).toEqual({ n: 3 });
  } finally { reader.exec("ROLLBACK"); reader.close(true); writer.close(true); }
});

test("preserves an existing destination and releases the writer after copy failure", () => {
  const { source, destination, writer } = fixture();
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    fs.writeFileSync(destination, "keep this file");
    expect(() => copySnapshotDatabaseFile(source, destination)).toThrow();
    expect(fs.readFileSync(destination, "utf8")).toBe("keep this file");
    writer.exec("INSERT INTO retained(value) VALUES('writer released')");
  } finally { writer.close(true); }
});
