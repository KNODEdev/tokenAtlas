import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { canonicalJson, digest, tablesDigest } from "./canonical-json";

/** The formula stored snapshot manifests were written with. */
const whole = (db: Database, tables: readonly string[]): string =>
  digest(Object.fromEntries(tables.map(table => [table,
    (db.query(`SELECT * FROM ${table}`).all() as unknown[]).map(canonicalJson).sort()])));

test("the piecewise table digest equals the digest of the whole value", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE zeta(id INTEGER PRIMARY KEY, payload TEXT, amount REAL, raw BLOB);
      CREATE TABLE alpha(name TEXT, note TEXT); CREATE TABLE empty(id INTEGER);`);
    const insert = db.prepare("INSERT INTO zeta(payload,amount) VALUES(?,?)");
    // More rows than one hashing chunk, with text that needs escaping and sorts unlike its ids.
    for (let index = 0; index < 2500; index++)
      insert.run(JSON.stringify({ n: 2500 - index, text: `zażółć "quoted" \ line\n${index}` }), index / 7);
    db.prepare("INSERT INTO alpha VALUES(?,?)").run("ą", null);
    for (const tables of [["zeta", "alpha", "empty"], ["empty"], ["zeta"], []])
      expect(tablesDigest(db, tables)).toBe(whole(db, tables));
  } finally { db.close(); }
});
