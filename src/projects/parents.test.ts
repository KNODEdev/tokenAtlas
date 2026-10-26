import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import { inheritedProject, parentPlaces, parentThreadId, readParentPlaces, readParentContexts, contextKey, type ParentPlace, type ParentRow } from "./parents";
import { compileProjectResolver, overrideProjectRules } from "./resolve";
import { currentProjectRules, codexProjectSql, placeProject } from "./rules-now";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const nested = (id: string) => `subagent:{'parent_thread_id': '${id}', 'depth': 1}`;
const cfg = { projects: [{ id: "mesflow", name: "mesFlow", matches: [{ cwd: "H:/work/mesFlow" }] },
  { id: "other", name: "Other", matches: [{ cwd: "H:/work/other" }] }] };
const root: ParentPlace = { store: "home", source: "codex/pc/profile", cwd: "H:/work/mesFlow", project: "mesFlow", repo: null, nested: "user" };
const child: ParentPlace = { ...root, cwd: "C:/Temp/random-uuid", project: "random-uuid", nested: nested(A) };
const parent = (place: ParentPlace, id = A): ParentRow => ({ ...place, conversation: `${place.source}|rollout-2026-10-15-${id}.jsonl` });
const base = compileProjectResolver(cfg, (_t, s) => [s]);
const explicit = compileProjectResolver(cfg, (_t, s) => [s], false);
const resolve = (place: ParentPlace, rows: ParentRow[], day = "2026-10-15") => inheritedProject(place, day, parentPlaces(rows),
  (p, d) => explicit.resolve("events", p, d), (p, d) => base.resolve("events", p, d));

test("parent UUID is parsed only from the provider's named subagent field", () => {
  expect(parentThreadId(nested(A))).toBe(A);
  expect(parentThreadId(`subagent:{\"parent_thread_id\":\"${A}\"}`)).toBe(A);
  for (const value of [null, A, `subagent:${A}`, `user:{'parent_thread_id':'${A}'}`, "subagent:{'parent_thread_id':'../x'}"]) expect(parentThreadId(value)).toBeNull();
});
test("arbitrary temporary folders inherit recorded parent and recursive ancestor within their source", () => {
  expect(resolve(child, [parent(root)])).toBe("mesflow");
  expect(resolve({ ...child, nested: nested(B) }, [parent(child, B), parent(root)])).toBe("mesflow");
  const spawned = { ...parent(child, B), conversation: `codex/pc/profile|rollout-prefix_${B}.jsonl` };
  expect(resolve({ ...child, nested: nested(B) }, [spawned, parent(root)])).toBe("mesflow");
  expect(resolve(child, [parent({ ...root, source: "codex/other/profile" })])).toBeNull();
});
test("missing, conflicting and cyclic parents stay unassigned; explicit child rules win", () => {
  expect(resolve(child, [])).toBeNull();
  expect(resolve(child, [parent(root), parent({ ...root, cwd: "H:/work/other" })])).toBeNull();
  expect(resolve(child, [parent({ ...child, nested: nested(B) }), parent({ ...child, nested: nested(A) }, B)])).toBeNull();
  expect(resolve({ ...child, cwd: "H:/work/other" }, [parent(root)])).toBe("other");
  expect(resolve(child, [parent(root), parent({ ...root, cwd: "C:/unknown" })])).toBeNull();
});

function database(file = ":memory:") {
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS usage_ledger_state(provider TEXT PRIMARY KEY,covered INTEGER,revision INTEGER);
    INSERT OR IGNORE INTO usage_ledger_state VALUES('codex',1,1);
    CREATE TABLE IF NOT EXISTS codex_price_ledger_dims(id INTEGER PRIMARY KEY,source TEXT,home TEXT,cwd TEXT,project TEXT,repo TEXT,nested TEXT);
    CREATE TABLE IF NOT EXISTS codex_price_ledger_copies(id INTEGER PRIMARY KEY,source TEXT,conversation TEXT);
    CREATE TABLE IF NOT EXISTS codex_price_ledger_file_models(copy_id INTEGER,dim_id INTEGER);
    INSERT OR IGNORE INTO codex_price_ledger_dims VALUES(1,'codex/pc/profile','home','H:/work/mesFlow','mesFlow',NULL,'user');
    INSERT OR IGNORE INTO codex_price_ledger_dims VALUES(2,'codex/pc/profile','home','C:/Temp/random-uuid','random-uuid',NULL,'${nested(A).replace(/'/g, "''")}');
    INSERT OR IGNORE INTO codex_price_ledger_copies VALUES(1,'codex/pc/profile','codex/pc/profile|rollout-2026-10-15-${A}.jsonl');
    INSERT INTO codex_price_ledger_file_models VALUES(1,1);`);
  overrideProjectRules(db, cfg); return db;
}

test("stored references retain every recursive parent proof and collapse repeated hour evidence", () => {
  const db = database();
  try {
    db.query("UPDATE codex_price_ledger_dims SET cwd='C:/temporary',nested=? WHERE id=1").run(nested(B));
    db.exec(`INSERT INTO codex_price_ledger_dims VALUES(3,'codex/pc/profile','home','H:/work/other','other',NULL,'user');
      INSERT INTO codex_price_ledger_copies VALUES(2,'codex/pc/profile','rollout_${B.toUpperCase()}.jsonl');
      INSERT INTO codex_price_ledger_file_models VALUES(2,3),(1,1),(1,1),(2,3);`);
    const contexts = readParentContexts(db), full = readParentPlaces(db), scoped = readParentPlaces(db, contexts);
    const changes = db.query("SELECT total_changes() n").get();
    for (const place of [child, { ...child, nested: nested(B) }]) {
      const resolveFrom = (parents: Map<string, ParentPlace[]>) => inheritedProject(place, "2026-10-15", parents,
        (p, d) => explicit.resolve("events", p, d), (p, d) => base.resolve("events", p, d));
      expect(resolveFrom(scoped)).toBe("other");
      expect(resolveFrom(scoped)).toBe(resolveFrom(full));
    }
    expect(scoped.get(contextKey(root.source!, A))).toHaveLength(1);
    expect(scoped.get(contextKey(root.source!, B))).toHaveLength(1);
    expect(placeProject(currentProjectRules(db), "codex", { ...child, home: child.store }, "2026-10-15")).toBe("other");
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally { overrideProjectRules(db, null); db.close(); }
});

test("a place absent from stored child references retains the general resolver's parent lookup", () => {
  const db = database();
  try {
    db.exec(`INSERT INTO codex_price_ledger_copies VALUES(2,'codex/pc/profile','rollout_${B}.jsonl');
      INSERT INTO codex_price_ledger_file_models VALUES(2,1);`);
    expect(readParentPlaces(db, readParentContexts(db)).has(contextKey(root.source!, B))).toBe(false);
    const rules = currentProjectRules(db), stamp = rules.resolver.stamp;
    expect(placeProject(rules, "codex", { ...child, home: child.store, nested: nested(B) }, "2026-10-15")).toBe("mesflow");
    expect(rules.resolver.stamp).toBe(stamp);
  } finally { overrideProjectRules(db, null); db.close(); }
});
test("JS and SQL use the same stored parent map; reads write nothing and register corrections invalidate it", () => {
  const db = database();
  try {
    const changes = () => (db.query("SELECT total_changes() n").get() as { n: number }).n;
    const before = changes();
    const rules = currentProjectRules(db), stamp = rules.resolver.stamp;
    expect(placeProject(rules, "codex", { ...child, home: child.store }, "2026-10-15")).toBe("mesflow");
    const query = () => `SELECT ${codexProjectSql(db, "d", "'2026-10-15'")} id FROM codex_price_ledger_dims d WHERE d.id=2`;
    expect((db.query(query()).get() as { id: string }).id).toBe("mesflow");
    expect(changes()).toBe(before);
    db.exec("UPDATE codex_price_ledger_dims SET cwd='H:/work/other' WHERE id=1; UPDATE usage_ledger_state SET covered=2,revision=2");
    expect(currentProjectRules(db).resolver.stamp).not.toBe(stamp);
    expect((db.query(query()).get() as { id: string }).id).toBe("other");
    expect(placeProject(currentProjectRules(db), "codex", { ...child, home: child.store }, "2026-10-15")).toBe("other");
    overrideProjectRules(db, { projects: cfg.projects.map(p => p.id === "other" ? { ...p, id: "corrected" } : p) });
    currentProjectRules(db);
    expect((db.query(query()).get() as { id: string }).id).toBe("corrected");
  } finally { overrideProjectRules(db, null); db.close(); }
});

test("dated parent resolutions reuse each day and invalidate both assigned and unassigned results", () => {
  const db = database();
  overrideProjectRules(db, { projects: [{ id: "during", name: "During", matches: [
    { cwd: "H:/work/mesFlow", from: "2026-10-10", until: "2026-10-20" },
  ] }] });
  try {
    const rules = currentProjectRules(db), resolve = spyOn(rules.resolver, "resolve");
    try {
      for (const [day, expected] of [["2026-10-09", null], ["2026-10-10", "during"], ["2026-10-19", "during"], ["2026-10-20", null]] as const) {
        for (let repeat = 0; repeat < 3; repeat++)
          expect(placeProject(rules, "codex", { ...child, home: child.store }, day)).toBe(expected);
      }
      expect(resolve).toHaveBeenCalledTimes(4);
    } finally { resolve.mockRestore(); }
    db.exec("UPDATE codex_price_ledger_dims SET cwd='C:/unknown',project='unknown' WHERE id=1; UPDATE usage_ledger_state SET covered=2,revision=2");
    expect(placeProject(currentProjectRules(db), "codex", { ...child, home: child.store }, "2026-10-10")).toBeNull();
    overrideProjectRules(db, { projects: [{ id: "corrected", name: "Corrected", matches: [{ cwd: "C:/unknown", from: "2026-10-01" }] }] });
    expect(placeProject(currentProjectRules(db), "codex", { ...child, home: child.store }, "2026-10-09")).toBe("corrected");
  } finally { overrideProjectRules(db, null); db.close(); }
});

test("recorded parent attribution survives readonly reopen and cache loss", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-parent-project-")), file = path.join(directory, "fixture.sqlite");
  const initial = database(file); initial.close();
  const reopened = new Database(file, { readonly: true });
  try {
    expect(placeProject(currentProjectRules(reopened), "codex", { ...child, home: child.store }, "2026-10-15")).toBe("mesflow");
    const sql = codexProjectSql(reopened, "d", "'2026-10-15'");
    expect((reopened.query(`SELECT ${sql} id FROM codex_price_ledger_dims d WHERE id=2`).get() as { id: string }).id).toBe("mesflow");
    expect(reopened.query("SELECT total_changes() n").get()).toEqual({ n: 0 });
  } finally {
    overrideProjectRules(reopened, null); reopened.close();
    fs.unlinkSync(file); fs.rmdirSync(directory);
  }
});
test("SQL and JS inherit the parent's raw-day assignments across dated declarations", () => {
  const db = database();
  const dated = { projects: [{ id: "during", name: "During", matches: [{ cwd: "H:/work/mesFlow", from: "2026-10-10", until: "2026-10-20" }] }, ...cfg.projects] };
  overrideProjectRules(db, dated);
  try {
    for (const [day, expected] of [["2026-10-09", "mesflow"], ["2026-10-10", "during"], ["2026-10-19", "during"], ["2026-10-20", "mesflow"]]) {
      expect(placeProject(currentProjectRules(db), "codex", { ...child, home: child.store }, day!)).toBe(expected!);
      const sql = codexProjectSql(db, "d", `'${day}'`);
      expect((db.query(`SELECT ${sql} id FROM codex_price_ledger_dims d WHERE id=2`).get() as { id: string }).id).toBe(expected!);
    }
  } finally { overrideProjectRules(db, null); db.close(); }
});
