import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSparkClassifier } from "./plan-health-read";
import { fixture, capture, instrument, assertBounded } from "../../scripts/benchmark-planhealth";

for (const account of ["unknown", "empty", "a", "A", "b", "codex1", ""]) {
  test(`full pinned response parity: ${account}`, async () => {
    const ctx = fixture(60);
    try { expect(await capture(ctx, account)).toEqual(await capture(ctx, account, true)); }
    finally { ctx.sqlite.close(); }
  });
}

test("COUNT weighting, NULL, LIKE, BINARY paths and shared memberships", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE events(path TEXT, model TEXT)");
    const put = db.query("INSERT INTO events VALUES (?, ?)");
    put.run("shared", "SpArK"); put.run("shared", null);
    put.run("heavy", "spark"); for (let i = 0; i < 9; i++) put.run("heavy", "gpt");
    put.run("LIGHT", "spark"); put.run("light", null);
    put.run("unicode", "SPÄRK"); put.run("empty", "");
    const memberships = [new Set(["shared"]), new Set(["shared", "heavy"]), new Set(["LIGHT"]), new Set(["light"]), new Set(["unicode"]), new Set(["missing"]), new Set(["empty"])];
    const read = readSparkClassifier(db, memberships);
    expect(memberships.map(read)).toEqual([false, false, true, false, false, false, false]);
    put.run("shared", "spark");
    expect(readSparkClassifier(db, memberships)(memberships[0]!)).toBe(true);
  } finally { db.close(); }
});

test("route work bound independent of cluster count", async () => {
  for (const clusters of [1, 12, 120]) {
    const ctx = fixture(clusters);
    try {
      const measured = instrument(ctx.sqlite);
      await capture({ ...ctx, sqlite: measured.sqlite }, "a");
      assertBounded(measured.samples);
      expect(measured.samples.length).toBe(1);
      const old = instrument(ctx.sqlite);
      await capture({ ...ctx, sqlite: old.sqlite }, "a", true);
      expect(old.samples.length).toBe(clusters);
    } finally { ctx.sqlite.close(); }
  }
});

test("more than SQLite bind limit selected paths, duplicates reuse evidence", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE events(path TEXT, model TEXT); INSERT INTO events VALUES ('p40000', 'spark')");
    const paths = new Set(Array.from({length: 40001}, (_, i) => `p${i}`));
    const measured = instrument(db);
    const read = readSparkClassifier(measured.sqlite, [paths, paths]);
    expect(read(paths)).toBe(true); assertBounded(measured.samples);
  } finally { db.close(); }
});

test("qualification and anchored 120-second clustering boundaries", async () => {
  const ctx = fixture(0);
  try {
    ctx.sqlite.exec("DELETE FROM ratelimit");
    const insert = ctx.sqlite.query("INSERT INTO ratelimit VALUES ('A', 'missing', ?, 10080, 'codex', ?, ?)");
    for (let i = 0; i < 4; i++) insert.run(`2026-08-0${i+1}`, 1000, i*20);
    let measured = instrument(ctx.sqlite);
    await capture({ ...ctx, sqlite: measured.sqlite }, "a");
    expect(measured.samples.length).toBe(0);
    insert.run("2026-08-05", 1120, 80);
    const qualified = await capture(ctx, "a");
    expect(qualified).toEqual(await capture(ctx, "a", true));
    expect(qualified.body.axes.axis3.current_value).toBe(1);
    insert.run("2026-08-06", 1121, 90);
    expect(await capture(ctx, "a")).toEqual(await capture(ctx, "a", true));
    expect((await capture(ctx, "a")).body.axes.axis3.current_value).toBe(1);
  } finally { ctx.sqlite.close(); }
});

test("read failures propagate, retry and appended events use fresh request evidence", async () => {
  const ctx = fixture();
  try {
    for (const old of [false, true]) {
      const measured = instrument(ctx.sqlite, 1);
      await expect(capture({ ...ctx, sqlite: measured.sqlite }, "a", old)).rejects.toThrow("injected classification read failure");
    }
    const before = await capture(ctx, "a");
    ctx.sqlite.exec("INSERT INTO events(home,path,ts,model,in_tok,cached_in,out_tok) SELECT 'B', 'p2', '1999', 'spark', 0, 0, 0 FROM events");
    const after = await capture(ctx, "a");
    expect(after).not.toEqual(before);
    expect(after).toEqual(await capture(ctx, "a", true));
    expect(await capture(ctx, "b")).toEqual(await capture(ctx, "b", true));
  } finally { ctx.sqlite.close(); }
});

test("restart sees committed changes and retains full response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planhealth-restart-"));
  const filename = path.join(root, "fixture.sqlite");
  const ctx = fixture(12, 0, filename);
  try {
    const before = await capture(ctx, "a");
    ctx.sqlite.close(); ctx.sqlite = new Database(filename);
    expect(await capture(ctx, "a")).toEqual(before);
    const freshProcess = () => {
      const code = `import { Database } from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
        import { fixture, capture } from "./scripts/benchmark-planhealth.ts";
        const ctx = fixture(0); ctx.sqlite.close(); ctx.sqlite = new Database(${JSON.stringify(filename)});
        console.log(JSON.stringify(await capture(ctx, "a"))); ctx.sqlite.close();`;
      const child = Bun.spawnSync([process.execPath, "-e", code], { cwd: process.cwd() });
      expect(child.exitCode).toBe(0);
      return JSON.parse(child.stdout.toString());
    };
    expect(freshProcess()).toEqual(before);
    ctx.sqlite.exec("INSERT INTO events(home,path,ts,model,in_tok,cached_in,out_tok) SELECT 'B', 'p2', '1999', 'spark', 0, 0, 0 FROM events");
    ctx.sqlite.close(); ctx.sqlite = new Database(filename);
    expect(await capture(ctx, "a")).not.toEqual(before);
    expect(freshProcess()).toEqual(await capture(ctx, "a", true));
    expect(await capture(ctx, "a")).toEqual(await capture(ctx, "a", true));
  } finally { ctx.sqlite.close(); fs.rmSync(root, { recursive: true }); }
});
