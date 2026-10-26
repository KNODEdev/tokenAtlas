/**
 * The read-time project resolver (resolve.ts) equals the remap's assignment (frozen in remap-project-oracle.ts since the
 * remap writes repositories only) for every distinct (table, store, cwd, project, repo, raw day): store-bound priority, first match wins, globs and prefixes over backslash and mixed-case directories,
 * repository and project names, dated rules, a Codex account label naming its homes. Synthetic database.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "../db/sqlite";
import { ARCHIVE_LOGICAL_ROOT, configFile } from "../config/paths";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { currentProjectRules } from "./rules-now";
import { overrideProjectRules } from "./resolve";
import { createTestDatabase } from "../sync/test-support";
import { ensureRawSyncIndexes } from "../db/migrate";
import { remap, type ProjectsConfig } from "./remap";
import { assignProjectsAsRemapDid } from "./remap-project-oracle";
import { compileProjectResolver, PROJECT_TABLES, projectCaseSql, projectStoreResolver, type ProjectTable } from "./resolve";

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CONFIG: ProjectsConfig = { projects: [
  { id: "dated", name: "Dated", matches: [{ cwd: "H:/_Dev/repos/products/alpha", from: "2026-09-12", until: "2026-09-14" }] },
  { id: "alpha", name: "Alpha", matches: [{ cwd: "H:/_Dev/repos/products/alpha" }] },
  { id: "globbed", name: "Globbed", matches: [{ cwd: "*/clients/*/web*" }] },
  { id: "by-repo", name: "By repo", matches: [{ repo: "BETA" }] },
  { id: "by-name", name: "By name", matches: [{ project: "Gamma" }] },
  { id: "store-bound", name: "Store bound", matches: [{ store: "mirror", cwd: "H:/_Dev/repos/products" }] },
  { id: "codex-account", name: "Codex account", matches: [{ store: "acct-c", project: "alpha" }] },
  { id: "late", name: "Late", matches: [{ cwd: "C:\\Work\\Delta\\", from: "2026-09-13" }] },
], repo: { roots: ["repos"], nested_groups: ["clients"] } };
const DIRS = ["H:/_Dev/repos/products/alpha", "h:\\_dev\\repos\\products\\alpha\\sub", "H:/_Dev/repos/products/alphabet", "H:/_Dev/repos/clients/acme/website",
  "H:/_Dev/repos/clients/acme/WebShop", "H:/_Dev/repos/products/beta", "H:/_Dev/repos/products/Beta/x", "C:/Work/Delta", "c:/work/delta/deep", "D:/other/gamma", null, ""];

test("the resolver equals the remap for every distinct key and raw day", () => {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  try {
    ensureRawSyncIndexes(db);
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
    db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
      VALUES('codex','codex/pc/profile','2000-01-01',NULL,'acct-c','declared',0,'fixture')`).run();
    const random = prng(3), pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const day = () => `2026-09-${String(10 + Math.floor(random() * 6)).padStart(2, "0")}T${pick(["00:30:00Z", "23:30:00+02:00", "12:00:00.000Z"])}`;
    for (let i = 0; i < 300; i++) {
      const cwd = pick(DIRS), project = pick(["alpha", "Gamma", "gamma", "beta", null]), store = pick(["primary", "mirror", "MIRROR"]);
      db.query("INSERT INTO claude_events(store,call_id,ts,cwd,project,path) VALUES(?,?,?,?,?,'p')").run(store, `c${i}`, day(), cwd, project);
      db.query("INSERT INTO oc_events(store,message_id,ts,directory,project) VALUES(?,?,?,?,?)").run(store, `m${i}`, day(), cwd, project);
      db.query("INSERT INTO grok_events(store,session_id,prompt_id,ts,cwd,project,path) VALUES(?,?,?,?,?,?,'p')").run(store, `s${i}`, `p${i}`, day(), cwd, project);
      db.query("INSERT INTO events(home,path,ts,cwd,project) VALUES(?,?,?,?,?)").run(pick(["H:/archive/codex/pc/profile", "C:/Users/x/.codex"]),
        `f${i}.jsonl`, day(), cwd, project);
    }
    const started = performance.now();
    remap(db, CONFIG);
    assignProjectsAsRemapDid(db, CONFIG, projectStoreResolver(db));
    if (process.env.TIMING) console.log("remap", Math.round(performance.now() - started));
    const resolver = compileProjectResolver(CONFIG, projectStoreResolver(db));
    const keys: Record<ProjectTable, [string, string]> = { claude_events: ["store", "cwd"], oc_events: ["store", "directory"], events: ["home", "cwd"],
      grok_events: ["store", "cwd"] };
    let compared = 0;
    const assigned = new Set<string | null>();
    for (const table of PROJECT_TABLES) {
      const [store, cwd] = keys[table];
      // The same rules as one SQL expression over the raw columns, as readers of stored rows use them.
      const sql = projectCaseSql(CONFIG, projectStoreResolver(db), table, { store, cwd, project: "project", repo: "repo", day: "substr(ts,1,10)" });
      expect(db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${sql} IS NOT project_id`).get()).toEqual({ n: 0 });
      for (const row of db.query(`SELECT DISTINCT ${store} store, ${cwd} cwd, project, repo, substr(ts,1,10) day, project_id FROM ${table}`).all() as
        Array<{ store: string | null; cwd: string | null; project: string | null; repo: string | null; day: string; project_id: string | null }>) {
        expect({ table, ...row, resolved: resolver.resolve(table, row, row.day) }).toEqual({ table, ...row, resolved: row.project_id });
        if (!resolver.dated(table, row)) for (const other of ["2026-01-01", "2026-09-13", "2027-01-01"])
          expect(resolver.resolve(table, row, other)).toBe(row.project_id);
        assigned.add(row.project_id);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
    expect(assigned).toEqual(new Set(["dated", "alpha", "globbed", "by-repo", "by-name", "store-bound", "late", null]));
  } finally {
    db.close(true);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);

test("a Codex account label names the homes of the sources its periods name", () => {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  try {
    db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
      VALUES('codex','codex/pc','2000-01-01',NULL,'acct-c','declared',0,'fixture')`).run();
    const accounts = `${directory}/accounts.json`;
    fs.writeFileSync(accounts, JSON.stringify({ version: 2, subscriptions: [], sources: [{ vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/pc` }] }));
    const stores = projectStoreResolver(db, accounts);
    expect(stores("claude_events", "acct-c")).toEqual(["acct-c"]);
    expect(stores("events", "nobody")).toEqual(["nobody"]);
    const resolver = compileProjectResolver({ projects: [{ id: "c", name: "C", matches: [{ store: "ACCT-C", project: "x" }] }] }, stores);
    const slashes = (value: string) => value.split("\\").join("/").toLowerCase();
    expect(stores("events", "ACCT-C").map(slashes)).toEqual([slashes(`${ARCHIVE_LOGICAL_ROOT}/codex/pc`)]);
    expect(resolver.resolve("events", { store: stores("events", "acct-c")[0]!, cwd: null, project: "X", repo: null }, "2026-01-01")).toBe("c");
    expect(resolver.resolve("events", { store: "acct-c", cwd: null, project: "x", repo: null }, "2026-01-01")).toBeNull();
  } finally {
    db.close(true);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a period replacement that keeps the rows' count and ids rebinds a store rule at once, per database", () => {
  const first = createTestDatabase(), second = createTestDatabase();
  const a = new Database(first.dbPath), b = new Database(second.dbPath), accounts = configFile("accounts.json");
  const previous = fs.existsSync(accounts) ? fs.readFileSync(accounts) : null;
  const period = (account: string) => ({ provider: "codex", subject: "codex/pc", from: "2000-01-01T00:00:00Z", until: null, value: account,
    origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
  try {
    fs.writeFileSync(accounts, JSON.stringify({ version: 2, subscriptions: [], sources: [{ vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/pc` }] }));
    const cfg = { projects: [{ id: "p", name: "P", matches: [{ store: "acct-a", project: "x" }] }] };
    for (const db of [a, b]) { overrideProjectRules(db, cfg); replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period("acct-a")]); }
    replaceDeclaredPeriods(b, ACCOUNT_PERIODS, [period("acct-b")]);
    const home = `${ARCHIVE_LOGICAL_ROOT}/codex/pc`, place = { store: home, cwd: null, project: "x", repo: null };
    const ids = (db: Database) => db.query("SELECT id, account FROM account_periods ORDER BY id").all();
    expect(currentProjectRules(a).projectOf("events", place, "2026-10-01")).toBe("p");
    expect(currentProjectRules(b).projectOf("events", place, "2026-10-01")).toBeNull();
    expect(currentProjectRules(a).projectOf("events", place, "2026-10-01")).toBe("p");
    // A to B: the same number of rows under the same ids, another account.
    const before = ids(a);
    replaceDeclaredPeriods(a, ACCOUNT_PERIODS, [period("acct-b")]);
    expect(ids(a).map(row => (row as { id: number }).id)).toEqual(before.map(row => (row as { id: number }).id));
    expect(currentProjectRules(a).projectOf("events", place, "2026-10-01")).toBeNull();
  } finally {
    if (previous) fs.writeFileSync(accounts, previous); else fs.rmSync(accounts, { force: true });
    a.close(true); b.close(true);
    for (const { directory } of [first, second]) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
