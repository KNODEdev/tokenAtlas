import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { queryRows, WhereClause } from "./data-groups";

test("queryRows reads the whole range and orders by the named columns, missing values first", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE events(ts TEXT, model TEXT, tokens INTEGER);
      INSERT INTO events VALUES('2026-01-02T10:00:00Z','b',2),('2026-01-01T10:00:00Z',NULL,1),('2026-01-03T10:00:00Z','a',3),('2026-01-04T10:00:00Z','a',4);`);
    const rows = queryRows<{ model: string | null; tokens: number }>(db,
      "SELECT model, SUM(tokens) tokens FROM events WHERE ts >= ? GROUP BY model", ["2026-01-01"], ["model"]);
    expect(rows).toEqual([{ model: null, tokens: 1 }, { model: "a", tokens: 7 }, { model: "b", tokens: 2 }]);
    expect(queryRows(db, "SELECT COUNT(*) n FROM events")).toEqual([{ n: 4 }]);
  } finally { db.close(); }
});

test("WhereClause keeps predicates and their parameters in order", () => {
  const where = new WhereClause();
  expect(where.clause()).toBe("");
  where.add("ts >= ?", ["2026-01-01"]).add("model IS NOT NULL").add("home IN (?,?)", ["a", "b"]);
  expect(where.clause()).toBe("WHERE ts >= ? AND model IS NOT NULL AND home IN (?,?)");
  expect(where.clause("AND")).toBe("AND ts >= ? AND model IS NOT NULL AND home IN (?,?)");
  expect(where.params).toEqual(["2026-01-01", "a", "b"]);
});
