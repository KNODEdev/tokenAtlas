import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ARCHIVE_ROOT, toArchiveLogicalPath } from "../config/paths";
import { boundedReparseInputs } from "./coordinator";

test("range discovery refills bounded stat slots and keeps late corrections in archive order", async () => {
  const db = new Database(":memory:");
  const original = fs.promises.stat;
  const files = Array.from({ length: 140 }, (_, index) => path.join(ARCHIVE_ROOT, "claude", "PC-fixture", `${index}.jsonl`));
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const visited: string[] = [];
  let running = 0, peak = 0;
  try {
    db.exec("CREATE TABLE claude_files(path TEXT,size INTEGER,mtime REAL)");
    const insert = db.query("INSERT INTO claude_files VALUES(?,10,100)");
    for (const file of files.slice(0, -1)) insert.run(toArchiveLogicalPath(file));
    fs.promises.stat = (async (file: fs.PathLike) => {
      const name = String(file);
      visited.push(name); peak = Math.max(peak, ++running);
      try {
        if (name === files[0]) await slow;
        else await Promise.resolve();
        if (name === files[65]) throw new Error("cloud source unavailable");
        // Same-size content correction in an old folder must still be selected.
        return { size: 10, mtimeMs: name === files[130] ? 101 : 100 };
      } finally { running--; }
    }) as typeof fs.promises.stat;
    const pending = boundedReparseInputs(db, "claude", [], files);
    // Allow fast slots to reach beyond the first group while file zero is blocked.
    for (let turn = 0; turn < 150; turn++) await Promise.resolve();
    expect(visited).toContain(files[130]!);
    release();
    expect(await pending).toEqual([files[65]!, files[130]!, files[139]!]);
    expect(visited).toHaveLength(139);
    expect(peak).toBeLessThanOrEqual(64);
  } finally { release?.(); fs.promises.stat = original; db.close(); }
});
