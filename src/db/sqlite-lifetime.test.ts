import { expect, test } from "bun:test";
import { Database } from "./sqlite";

test("strict close finalizes native handles after their statement wrappers are collected", () => {
  const db = new Database(":memory:");
  const statement = db.prepare("SELECT 7 AS n");
  const native = statement.native as { finalize(): void; get(): unknown };
  const tracked = (db as unknown as { statements: Map<WeakRef<typeof statement>, typeof native> }).statements;
  const reference = [...tracked.keys()][0]!;
  // Model the exact post-collection state without relying on GC scheduling or conservative stack roots.
  // The churn test below still exercises real wrapper collection and sweeping.
  Object.defineProperty(reference, "deref", { value: () => undefined });
  try {
    expect(reference.deref()).toBeUndefined();
    expect(native.get()).toEqual({ n: 7 });
    expect(() => db.close(true)).not.toThrow();
    expect(() => native.get()).toThrow();
  } finally { native.finalize(); db.close(true); }
});

test("dynamic statement churn releases abandoned handles while preserving held statements and iterators", async () => {
  const db = new Database(":memory:");
  const held = db.prepare("SELECT ? AS n");
  const iterator = db.prepare("SELECT 1 AS n UNION ALL SELECT 2").iterate();
  expect(iterator.next().value).toEqual({ n: 1 });
  try {
    for (let batch = 0; batch < 5; batch++) {
      const abandoned = Array.from({ length: 256 }, (_, index) => {
        const statement = db.prepare(`SELECT ${batch * 256 + index} AS n`);
        return { reference: new WeakRef(statement), native: statement.native as { get(): unknown } };
      });
      await Bun.sleep(0);
      Bun.gc(true);
      // Trigger sweeping without relying on FinalizationRegistry callback timing. The sweep
      // interval follows the tracked set, which this test never grows past 2 048 statements.
      for (let index = 0; index < 2048; index++) db.prepare("SELECT 0").finalize();
      const collected = abandoned.filter(({ reference }) => !reference.deref());
      expect(collected.length).toBeGreaterThan(200);
      for (const { native } of collected) expect(() => native.get()).toThrow();
      expect(held.get(batch)).toEqual({ n: batch });
    }
    expect(iterator.next().value).toEqual({ n: 2 });
    expect(iterator.next().done).toBe(true);
    held.finalize();
    held.finalize();
    expect(() => held.get(1)).toThrow();
    expect(() => db.close(true)).not.toThrow();
  } finally { db.close(true); }
});

test("query() reuses one statement per SQL text beyond Bun's 20-entry cache and stays bounded", () => {
  const db = new Database(":memory:");
  const tracked = () => (db as unknown as { statements: Map<unknown, unknown> }).statements.size;
  try {
    for (let index = 0; index < 40; index++) db.query(`SELECT ${index} AS n`).get();
    const late = db.query("SELECT 39 AS n");
    const before = tracked();
    // A per-row query: prepared once, however often it runs.
    for (let row = 0; row < 5000; row++) expect(db.query("SELECT 39 AS n")).toBe(late);
    expect(tracked()).toBe(before);
    // Dynamic SQL cannot grow the cache without limit; the least recently used entry leaves it.
    for (let index = 0; index < 2000; index++) db.query(`SELECT ${index} + 1000 AS n`);
    expect(db.query("SELECT 39 AS n")).not.toBe(late);
    expect((db as unknown as { queryCache: Map<string, unknown> }).queryCache.size).toBeLessThanOrEqual(1024);
    // A lazy iteration keeps its statement to itself, so a nested call cannot reset it.
    const rows = db.query("SELECT 1 AS n UNION ALL SELECT 2").iterate();
    expect(rows.next().value).toEqual({ n: 1 });
    expect(db.query("SELECT 1 AS n UNION ALL SELECT 2").all()).toHaveLength(2);
    expect(rows.next().value).toEqual({ n: 2 });
    // A finalized statement never comes back from the cache.
    const closed = db.query("SELECT 'closed' AS n"); closed.finalize();
    expect(db.query("SELECT 'closed' AS n").get()).toEqual({ n: "closed" });
    expect(() => db.close(true)).not.toThrow();
  } finally { db.close(true); }
});
