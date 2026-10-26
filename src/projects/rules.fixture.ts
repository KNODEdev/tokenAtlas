import type { Database } from "../db/sqlite";
import { compileProjectResolver, hasProjectRulesOverride, overrideProjectRules, PROJECT_TABLES, projectRulesOverride, type ProjectTable } from "./resolve";
import fs from "node:fs";
import { PROJECTS_PATH, saveProjects, type ProjectDef, type ProjectMatch } from "./remap";

/**
 * Test support: fixtures written before project rules applied at read time put a call's project into its raw row
 * (`project_id`, or a Codex `subject` of `p:<id>` / `r:<repo>`). This gives the database the rules that assign exactly
 * those projects - one rule per (directory, project name) of a project's rows, or a marker project name when a row has
 * neither - and checks that the rules give every raw row its project (none for a row without one). Call it after the raw
 * rows are written and before the ledgers are filled (a marker or a repository becomes part of a call's place).
 */
const derivedConnections = new WeakSet<Database>(), derivedFiles = new Set<string>();
const fileOf = (db: Database) => { const name = (db as unknown as { filename?: string }).filename; return name && name !== ":memory:" ? name : null; };
const derived = { has: (db: Database) => derivedConnections.has(db) || derivedFiles.has(fileOf(db) ?? ""),
  add: (db: Database) => { derivedConnections.add(db); const file = fileOf(db); if (file) derivedFiles.add(file); } };
export function projectRulesFromRawRows(db: Database): void {
  // A test that states its rules keeps them; rules derived here follow rows added since.
  if (hasProjectRulesOverride(db) && !derived.has(db)) return;
  const projects = new Map<string, ProjectMatch[]>();
  const add = (id: string, match: ProjectMatch) => {
    const list = projects.get(id) ?? projects.set(id, []).get(id)!;
    if (!list.some(m => JSON.stringify(m) === JSON.stringify(match))) list.push(match);
  };
  const specs: Array<{ table: ProjectTable; cwd: string | null; id: string }> = [];
  for (const table of PROJECT_TABLES) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    const cwd = table === "oc_events" ? "directory" : "cwd";
    const subject = table === "events" && columns.has("subject");
    if (!columns.has("project_id") && !subject) continue;
    if (!columns.has("project")) db.exec(`ALTER TABLE ${table} ADD COLUMN project TEXT`);
    if (subject && !columns.has("repo")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN repo TEXT`);
      db.exec(`UPDATE ${table} SET repo=substr(subject,3) WHERE subject LIKE 'r:%'`);
    }
    const ids = [columns.has("project_id") ? "NULLIF(CAST(project_id AS TEXT),'')" : null,
      subject ? "CASE WHEN subject LIKE 'p:%' THEN substr(subject,3) END" : null].filter(Boolean);
    const idSql = ids.length > 1 ? `COALESCE(${ids.join(",")})` : ids[0]!;
    const cwdSql = columns.has(cwd) ? cwd : "NULL";
    // A marker follows its row's project id (a fixture's correction moves the call's place, as a real one does).
    db.exec(`UPDATE ${table} SET project=CASE WHEN ${idSql} IS NULL THEN NULL ELSE 'fixture:'||${idSql} END
      WHERE project LIKE 'fixture:%' AND project IS NOT 'fixture:'||${idSql}`);
    db.exec(`UPDATE ${table} SET project='fixture:'||${idSql} WHERE ${idSql} IS NOT NULL AND ${cwdSql} IS NULL AND project IS NULL`);
    for (const row of db.query(`SELECT DISTINCT ${idSql} id, ${cwdSql} cwd, project FROM ${table} WHERE ${idSql} IS NOT NULL`).all() as
      Array<{ id: string; cwd: string | null; project: string | null }>) {
      add(row.id, { ...(row.cwd ? { cwd: row.cwd.replace(/\\/g, "/") } : {}), ...(row.project ? { project: row.project } : {}) });
    }
    specs.push({ table, cwd: columns.has(cwd) ? cwd : null, id: idSql });
  }
  // A fixture without raw projects reads projects.json (its own configuration), as the application does.
  if (!projects.size && !derived.has(db)) return;
  // Deeper directories first, so a project inside another one's folder keeps its own calls.
  const depth = (m: ProjectMatch) => (m.cwd?.split("/").length ?? 0) * 2 + (m.project ? 1 : 0);
  const defs: ProjectDef[] = [...projects].map(([id, matches]) => ({ id, name: id, matches }));
  const ordered = defs.flatMap(def => def.matches.map(m => ({ id: def.id, m }))).sort((a, b) => depth(b.m) - depth(a.m));
  const cfg = { projects: ordered.map(({ id, m }) => ({ id, name: id, matches: [m] })) };
  const resolver = compileProjectResolver(cfg, (_table, store) => [store]);
  for (const spec of specs) {
    for (const row of db.query(`SELECT ${spec.id} id, ${spec.cwd ?? "NULL"} cwd, project, ts FROM ${spec.table}`).all() as
      Array<{ id: string | null; cwd: string | null; project: string | null; ts: string | null }>) {
      const got = resolver.resolve(spec.table, { store: null, cwd: row.cwd, project: row.project, repo: null }, String(row.ts ?? "").slice(0, 10));
      if (got !== row.id) throw new Error(`fixture rules cannot express ${spec.table} row ${JSON.stringify(row)}: rules give ${got}`);
    }
  }
  overrideProjectRules(db, cfg);
  derived.add(db);
}

/**
 * Test support: writes a database's fixture rules to projects.json, for readers in other threads or processes (an
 * analysis worker) that see the file, not this process's override. Returns the restore of the previous file.
 */
export function publishFixtureRules(db: Database): () => void {
  const previous = fs.existsSync(PROJECTS_PATH) ? fs.readFileSync(PROJECTS_PATH) : null;
  saveProjects(projectRulesOverride(db) ?? { projects: [] });
  return () => { if (previous) fs.writeFileSync(PROJECTS_PATH, previous); else fs.rmSync(PROJECTS_PATH, { force: true }); };
}
