import type { Database } from "../db/sqlite";
import type { ProjectMatch, ProjectsConfig } from "./remap";
import type { ProjectTable } from "./resolve";

/**
 * Test oracle: the project assignment the remap wrote into raw rows until step 7 of
 * docs/stored-activity-plan-2026-10-07.md (`projectCase` in remap.ts at 3fb02c4, kept verbatim in its SQL), so the
 * read-time resolver (resolve.ts) stays checked against it. Writes `project_id` of every row of the raw tables.
 */
const RAW: Record<ProjectTable, { storeCol: string; cwdCol: string; projectCol: string }> = {
  claude_events: { storeCol: "store", cwdCol: "cwd", projectCol: "project" },
  oc_events: { storeCol: "store", cwdCol: "directory", projectCol: "project" },
  events: { storeCol: "home", cwdCol: "cwd", projectCol: "project" },
  grok_events: { storeCol: "store", cwdCol: "cwd", projectCol: "project" },
};
const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const NORM_COL = (col: string) => `lower(replace(${col}, '\\', '/'))`;
function cwdClause(col: string, pattern: string): { sql: string; params: string[] } {
  const n = normPath(pattern);
  const c = NORM_COL(col);
  if (/[*?[]/.test(n)) return { sql: `${c} GLOB ?`, params: [n] };
  return { sql: `(${c} = ? OR ${c} GLOB ?)`, params: [n, n + "/*"] };
}

export function assignProjectsAsRemapDid(db: Database, cfg: ProjectsConfig, resolveStore: (table: ProjectTable, store: string) => string[]): void {
  const rules: Array<{ id: string; m: ProjectMatch }> = [];
  for (const p of cfg.projects) for (const m of p.matches ?? []) rules.push({ id: p.id, m });
  rules.sort((a, b) => Number(!!b.m.store) - Number(!!a.m.store));
  for (const [table, spec] of Object.entries(RAW) as Array<[ProjectTable, typeof RAW[ProjectTable]]>) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    if (!columns.has("project_id")) continue;
    const cwdCol = columns.has(spec.cwdCol) ? spec.cwdCol : null, repoColumn = columns.has("repo") ? "repo" : null;
    const cases: string[] = [], bindings: string[] = [];
    for (const { id, m } of rules) {
      const where: string[] = [], params: string[] = [];
      if (m.store) {
        const vals = resolveStore(table, m.store);
        where.push(`${NORM_COL(spec.storeCol)} IN (${vals.map(() => "?").join(",")})`);
        params.push(...vals.map(normPath));
      }
      if (m.cwd) {
        if (!cwdCol) {
          if (/[*?[]/.test(m.cwd)) continue;
          const base = normPath(m.cwd).split("/").pop();
          if (!base) continue;
          where.push(`lower(${spec.projectCol}) = ?`);
          params.push(base);
        } else {
          const c = cwdClause(cwdCol, m.cwd);
          where.push(c.sql);
          params.push(...c.params);
        }
      }
      if (m.repo) {
        if (!repoColumn) continue;
        where.push(`lower(${repoColumn}) = ?`);
        params.push(m.repo.toLowerCase());
      }
      if (m.project) {
        where.push(`lower(${spec.projectCol}) = ?`);
        params.push(m.project.toLowerCase());
      }
      if (m.from) { where.push("substr(ts,1,10) >= ?"); params.push(m.from); }
      if (m.until) { where.push("substr(ts,1,10) < ?"); params.push(m.until); }
      cases.push(`WHEN ${where.join(" AND ") || "1"} THEN ?`);
      bindings.push(...params, id);
    }
    db.query(`UPDATE ${table} SET project_id = ${cases.length ? `CASE ${cases.join(" ")} ELSE NULL END` : "NULL"}`).run(...bindings);
  }
}
