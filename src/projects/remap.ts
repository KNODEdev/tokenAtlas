import { Database } from "../db/sqlite";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { REPO_ROOT, configFile, configWriteTarget } from "../config/paths";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { ensureRepoColumns } from "../db/derived-columns";
import { deriveRepo, type RepoConfig } from "./repo";
import { markCodexLedgerCopiesDirty, type LedgerDirtyCopy } from "../db/codex-ledger-producer";
export interface ProjectMatch {
  store?: string;
  cwd?: string;
  repo?: string;
  project?: string;
  from?: string;
  until?: string;
}
export interface ProjectDef {
  id: string;
  name: string;
  matches: ProjectMatch[];
  note?: string;
}
export interface ProjectsConfig {
  _comment?: string[];
  projects: ProjectDef[];
  repo?: RepoConfig;
}
import { projectStoreResolver } from "./resolve";
export const ROOT_DIR = REPO_ROOT;
export const PROJECTS_PATH = configFile("projects.json");
const EMPTY: ProjectsConfig = {
  _comment: [
    "Canonical project list for tokenAtlas. Raw events keep their cwd; this file",
    "says which project a cwd belongs to. Edit by hand or via the Projects screen,",
    "then `bun run remap` (ingest runs it automatically).",
    "match: { store?, cwd? (prefix or glob), repo? (derived repo), project? (basename), from?, until? }",
  ],
  projects: [],
};
/**
 * The fingerprint of what the remap writes into the raw rows: the repository configuration only. Project rules apply
 * at read time (resolve.ts), so changing them writes nothing and needs no remap.
 */
export function rulesFingerprint(file = PROJECTS_PATH): string {
  if (!fs.existsSync(file)) return "none";
  const cfg = loadProjects(file);
  return createHash("sha256").update(`repo-only|${JSON.stringify(cfg.repo ?? null)}`).digest("hex").slice(0, 16);
}
export function storedFingerprint(sqlite: Database): string | null {
  try {
    const row = sqlite.query(`SELECT value FROM meta WHERE key = 'projects_fingerprint'`).get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}
/** The raw tables whose rows the project remap maps. */
export const REMAPPED_TABLES: readonly string[] = ["claude_events", "oc_events", "events", "grok_events"];

/**
 * After a stage mapped under `stageRules` (null: not mapped) published into the main database:
 * the stored fingerprint asserts that every row of the remapped tables follows those rules. Main
 * tables that held no rows before take the stage's rules; rows mapped under other rules leave no
 * such assertion, so the next project change remaps the main database. Inside the publication.
 */
export function recordPublishedProjectRules(main: Database, stageRules: string | null, mainHadRows: boolean): void {
  if (stageRules !== null && (!mainHadRows || storedFingerprint(main) === stageRules)) storeFingerprint(main, stageRules);
  else main.run("DELETE FROM meta WHERE key = 'projects_fingerprint'");
}
function storeFingerprint(sqlite: Database, fp: string): void {
  try {
    sqlite.run(`INSERT INTO meta (key, value) VALUES ('projects_fingerprint', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [fp]);
  } catch {
  }
}
export function loadProjects(file = PROJECTS_PATH): ProjectsConfig {
  if (!fs.existsSync(file)) return structuredClone(EMPTY);
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<ProjectsConfig>;
  return { ...parsed, projects: parsed.projects ?? [] };
}
export function saveProjects(cfg: ProjectsConfig, file?: string): void {
  const target = file ?? configWriteTarget("projects.json");
  atomicArchiveWrite(target, JSON.stringify(cfg, null, 2) + "\n");
}
export function validateProjects(cfg: ProjectsConfig): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const p of cfg.projects) {
    if (!p.id || !/^[a-z0-9_][a-z0-9_-]*$/i.test(p.id)) errors.push(`project id '${p.id}' must be [a-z0-9_-]`);
    if (seen.has(p.id)) errors.push(`duplicate project id '${p.id}'`);
    seen.add(p.id);
    if (!p.name) errors.push(`project '${p.id}' has no name`);
    for (const m of p.matches ?? []) {
      if (!m.cwd && !m.project && !m.repo) errors.push(`project '${p.id}': a match needs cwd, repo or project`);
      for (const d of [m.from, m.until]) {
        if (d !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push(`project '${p.id}': bad date '${d}'`);
      }
    }
  }
  return errors;
}
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
const NORM_COL = (col: string) => `lower(replace(${col}, '\\', '/'))`;
function cwdClause(col: string, pattern: string): { sql: string; params: string[] } {
  const n = normPath(pattern);
  const c = NORM_COL(col);
  if (/[*?[]/.test(n)) return { sql: `${c} GLOB ?`, params: [n] };
  return { sql: `(${c} = ? OR ${c} GLOB ?)`, params: [n, n + "/*"] };
}
interface TableSpec {
  table: string;
  storeCol: string;
  cwdCol: string | null;
  projectCol: string;
  resolveStore: (store: string) => string[];
}
function tableSpecs(sqlite: Database): TableSpec[] {
  // The rules' store bindings are the read-time resolver's (resolve.ts), so both assign the same projects.
  const stores = projectStoreResolver(sqlite);
  return [
    // Each table here is in REMAPPED_TABLES.
    { table: "claude_events", storeCol: "store", cwdCol: "cwd", projectCol: "project", resolveStore: (s) => stores("claude_events", s) },
    { table: "oc_events", storeCol: "store", cwdCol: "directory", projectCol: "project", resolveStore: (s) => stores("oc_events", s) },
    { table: "events", storeCol: "home", cwdCol: "cwd", projectCol: "project", resolveStore: (s) => stores("events", s) },
    { table: "grok_events", storeCol: "store", cwdCol: "cwd", projectCol: "project", resolveStore: (s) => stores("grok_events", s) },
  ];
}
export interface RemapResult {
  rules: number;
  perTable: Record<string, { assigned: number; total: number }>;
  repoPerTable?: Record<string, { assigned: number; total: number }>;
}

/** Emitted per table, not per row: the UPDATEs below are single statements that
 *  SQLite runs to completion, so there is nothing finer to report from inside
 *  one. The four phases are what a reader can actually wait through. */
export interface RemapProgress {
  phase: "repos" | "gaps" | "projects" | "finalize" | "done";
  phase_index: number;
  phase_count: number;
  message: string;
  table?: string;
  item_index?: number;
  item_count?: number;
  assigned?: number;
  total?: number;
  result?: RemapResult;
}

export type RemapProgressHandler = (progress: RemapProgress) => void;
/** Whether this database's Codex ledger holds copy dimensions a repository or project change must refresh. */
function codexLedgerTracksCopies(sqlite: Database): boolean {
  if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_price_ledger_copies'").get()
    || !sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) return false;
  // Empty replacement stages have no durable copy dimensions to invalidate.
  return !!sqlite.query("SELECT 1 FROM codex_price_ledger_copies LIMIT 1").get();
}
export function repoKey(s: string): string {
  return s.toLowerCase();
}
function canonicalCasing(votes: Map<string, Map<string, number>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, variants] of votes) {
    let best: string | null = null;
    let bestN = -1;
    for (const [variant, n] of variants) {
      if (n > bestN || (n === bestN && best !== null && variant < best)) {
        best = variant;
        bestN = n;
      }
    }
    if (best !== null) out.set(key, best);
  }
  return out;
}
function canonSegments(value: string, canon: Map<string, string>): string {
  return value
    .split("/")
    .map((seg) => canon.get(repoKey(seg)) ?? seg)
    .join("/");
}

interface UsableTable { spec: TableSpec; cwdCol: string | null; cols: Set<string> }
function usableTables(sqlite: Database): UsableTable[] {
  return tableSpecs(sqlite).flatMap(spec => {
    if (!sqlite.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(spec.table)) return [];
    const cols = new Set((sqlite.query(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>).map((c) => c.name));
    return [{ spec, cols, cwdCol: spec.cwdCol && cols.has(spec.cwdCol) ? spec.cwdCol : null }];
  });
}

/** Repository of every working directory, with segment casing voted across all tables (a repo keeps one spelling). */
function repositoryMaps(sqlite: Database, tables: readonly UsableTable[], cfg?: RepoConfig): Map<string, Array<{ cwd: string; repo: string | null; group: string | null }>> {
  const dirsPerTable = new Map<string, Array<{ cwd: string; n: number }>>();
  const votes = new Map<string, Map<string, number>>();
  const vote = (value: string, n: number) => {
    for (const seg of value.split("/")) {
      if (!seg) continue;
      const key = repoKey(seg);
      const variants = votes.get(key) ?? new Map<string, number>();
      variants.set(seg, (variants.get(seg) ?? 0) + n);
      votes.set(key, variants);
    }
  };
  for (const { spec, cwdCol } of tables) {
    if (!cwdCol) continue;
    const dirs = sqlite.query(`SELECT ${cwdCol} AS cwd, COUNT(*) AS n FROM ${spec.table}
      WHERE ${cwdCol} IS NOT NULL AND ${cwdCol} != '' GROUP BY ${cwdCol}`).all() as Array<{ cwd: string; n: number }>;
    dirsPerTable.set(spec.table, dirs);
    for (const d of dirs) {
      const { repo, group } = deriveRepo(d.cwd, cfg);
      if (repo) vote(repo, d.n);
      if (group) vote(group, d.n);
    }
  }
  const canon = canonicalCasing(votes);
  return new Map([...dirsPerTable].map(([table, dirs]) => [table, dirs.map(d => {
    const { repo, group } = deriveRepo(d.cwd, cfg);
    return { cwd: d.cwd, repo: repo ? canonSegments(repo, canon) : null, group: group ? canonSegments(group, canon) : null };
  })]));
}

/**
 * Assigns the repository columns of one table in one write of each changed row; rows whose values do not change are not
 * written. Codex copies whose repository changes are queued for their ledger in the same transaction (the repository is
 * part of a call's place, which its ledger dimension is keyed by).
 */
function assignDerivedColumns(sqlite: Database, table: UsableTable, repos: Array<{ cwd: string; repo: string | null; group: string | null }>): void {
  const { spec, cwdCol } = table;
  if (!cwdCol) return;
  ensureRepoColumns(sqlite, spec.table);
  const dropTemp = () => { sqlite.run("DROP TABLE IF EXISTS temp.remap_repos"); sqlite.run("DROP TABLE IF EXISTS temp.remap_rows"); };
  dropTemp();
  // Inputs are read under the writer they are written with: a reader's snapshot cannot go stale.
  try { sqlite.transaction(() => {
    sqlite.run("CREATE TEMP TABLE remap_repos (cwd TEXT PRIMARY KEY, repo TEXT, grp TEXT)");
    {
      using ins = sqlite.prepare("INSERT OR REPLACE INTO temp.remap_repos (cwd, repo, grp) VALUES (?, ?, ?)");
      for (const d of repos) ins.run(d.cwd, d.repo, d.group);
    }
    sqlite.run(`CREATE TEMP TABLE remap_rows AS SELECT e.rowid AS rid, r.repo AS repo, r.grp AS repo_group
      FROM ${spec.table} e LEFT JOIN temp.remap_repos r ON r.cwd = e.${cwdCol}`);
    if (spec.table === "events" && codexLedgerTracksCopies(sqlite)) {
      const cols = new Set((sqlite.query(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has("home") || !cols.has("path")) throw new Error("Codex repository remap requires physical copy locators");
      markCodexLedgerCopiesDirty(sqlite, sqlite.query(`SELECT DISTINCT t.home, t.path FROM temp.remap_rows s JOIN events t ON t.rowid = s.rid
        WHERE t.repo IS NOT s.repo`).all() as LedgerDirtyCopy[]);
    }
    sqlite.run(`UPDATE ${spec.table} AS t SET repo = s.repo, repo_group = s.repo_group
      FROM temp.remap_rows s WHERE s.rid = t.rowid AND (t.repo IS NOT s.repo OR t.repo_group IS NOT s.repo_group)`);
  }).immediate(); } finally { dropTemp(); }
}

/** Repository columns only, for every table that records a working directory. */
export function remapRepos(sqlite: Database, cfg?: RepoConfig, onProgress?: RemapProgressHandler,
  tables?: readonly string[]): Record<string, { assigned: number; total: number }> {
  const usable = usableTables(sqlite);
  const maps = repositoryMaps(sqlite, usable, cfg);
  const out: Record<string, { assigned: number; total: number }> = {};
  for (const [index, table] of usable.entries()) {
    if (!table.cwdCol || tables && !tables.includes(table.spec.table)) continue;
    onProgress?.({ phase: "repos", phase_index: 1, phase_count: 4, message: `Wyliczam repozytoria w ${table.spec.table}`,
      table: table.spec.table, item_index: index + 1, item_count: usable.length });
    assignDerivedColumns(sqlite, table, maps.get(table.spec.table) ?? []);
    out[table.spec.table] = sqlite.query(`SELECT count(*) AS total, count(repo) AS assigned FROM ${table.spec.table}`)
      .get() as { assigned: number; total: number };
  }
  return out;
}
/**
 * The derived columns of the raw rows: repositories from working directories (repo config). Projects are not written:
 * their rules apply at read time (resolve.ts, rules-now.ts), so a rule change costs no remap and no ledger work.
 */
export function remap(
  sqlite: Database,
  cfg: ProjectsConfig = loadProjects(),
  onProgress?: RemapProgressHandler,
  tables?: readonly string[],
): RemapResult {
  const errors = validateProjects(cfg);
  if (errors.length) throw new Error("projects.json invalid: " + errors.join("; "));
  const result: RemapResult = { rules: cfg.projects.reduce((n, p) => n + (p.matches?.length ?? 0), 0), perTable: {}, repoPerTable: {} };
  // Phase numbers keep the four-phase scale the status bar shows (repos 1, finalize 4; gaps and projects are gone).
  onProgress?.({ phase: "repos", phase_index: 1, phase_count: 4, message: "Rozpoznaję repozytoria z katalogów roboczych" });
  result.repoPerTable = remapRepos(sqlite, cfg.repo, onProgress, tables);
  onProgress?.({ phase: "finalize", phase_index: 4, phase_count: 4, message: "Zapisuję odcisk aktualnej konfiguracji repozytoriów" });
  storeFingerprint(sqlite, rulesFingerprint());
  onProgress?.({ phase: "done", phase_index: 4, phase_count: 4, message: "Mapowanie zakończone", result });
  return result;
}
if (import.meta.main) {
  const { initDb } = await import("../db");
  const { WriteLease } = await import("../db/write-lease");
  const { sqlite } = initDb();
  // Remapping rewrites whole tables: it holds the write lease, which the server's background
  // writer hands over at its next batch boundary (U2.2).
  const lease = new WriteLease(sqlite, "remap");
  await lease.acquire();
  // The server parses these lines back out of stdout; the prefix keeps them
  // apart from the human-readable summary printed below.
  const progressJson = process.argv.includes("--progress-json");
  const r = remap(
    sqlite,
    undefined,
    progressJson ? (progress) => console.log(`@@tokenatlas-progress ${JSON.stringify(progress)}`) : undefined,
  );
  console.log(`[remap] ${r.rules} rule(s)`);
  const pct = (v: { assigned: number; total: number }) =>
    v.total ? ` (${((v.assigned / v.total) * 100).toFixed(1)}%)` : "";
  console.log("  derived repo:");
  for (const [t, v] of Object.entries(r.repoPerTable ?? {})) {
    console.log(`    ${t}: ${v.assigned.toLocaleString()} / ${v.total.toLocaleString()}${pct(v)}`);
  }
  lease.release();
  sqlite.close();
}
