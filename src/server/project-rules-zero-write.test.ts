/**
 * Project rules apply at read time (docs/stored-activity-plan-2026-10-07.md, step 7): adding a folder to a project, moving
 * a rule to `_tmp` and a dated rule are saved through the project API and write nothing to the database (`total_changes`
 * of the connection stays the same, no ledger work is queued), while every project read follows the new rules at once:
 * each project's calls per day equal those the remap's frozen CASE gives the raw calls (the oracle below).
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { handleProjectsAssign, handleProjectsReassign, handleProjectsUpdate, handleSummary, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { loadProjects, PROJECTS_PATH, saveProjects, type ProjectsConfig } from "../projects/remap";
import { assignProjectsAsRemapDid } from "../projects/remap-project-oracle";
import type { ProjectTable } from "../projects/resolve";

const CARD = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../rate-cards.json"), "utf8")) as RateCard;
const CLAUDE = `${ARCHIVE_LOGICAL_ROOT}/claude/PC-A`, CODEX = `${ARCHIVE_LOGICAL_ROOT}/codex/PC-A-user`;
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close(true);
  // projects.json belongs to the test process's configuration: later tests start without rules.
  fs.rmSync(PROJECTS_PATH, { force: true });
});

interface Call { table: ProjectTable; ts: string; cwd: string; project: string }
const CALLS: Call[] = [];
for (const [day, cwd] of [["2026-09-10", "C:/work/alpha"], ["2026-09-11", "C:/work/alpha/api"], ["2026-09-12", "C:/work/beta"],
  ["2026-09-13", "C:/work/beta"], ["2026-09-14", "C:/work/gamma"]] as const) {
  CALLS.push({ table: "claude_events", ts: `${day}T10:00:00.000Z`, cwd, project: cwd.split("/").pop()! });
  CALLS.push({ table: "events", ts: `${day}T11:00:00.000Z`, cwd, project: cwd.split("/").pop()! });
}

function database(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT,
    model TEXT, effort TEXT, project TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
    reasoning_out INTEGER, cwd TEXT, project_id TEXT)`);
  CALLS.forEach((call, index) => {
    if (call.table === "claude_events") db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,in_uncached,out_total,project,cwd)
      VALUES ('live',?,?,?,?,'claude-opus-5','standard',1000,10,?,?)`).run(`call-${index}`, `session-${index}`, `${CLAUDE}/H---work/${index}.jsonl`,
      call.ts, call.project, call.cwd);
    else db.query(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,cwd,project)
      VALUES (?,?,?,'gpt-5',300,100,0,50,0,?,?)`).run(CODEX, `${CODEX}/sessions/${index}.jsonl`, call.ts, call.cwd, call.project);
  });
  prepareUsageRegisters(db, CARD);
  return db;
}
const context = (db: Database) => ({ sqlite: db, rateCards: CARD, accounts: { subscriptions: [], sources: [] }, homeToSubId: new Map(),
  subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null, claudeGauge: {}, grokGauge: {}, plans: { segments: [] },
  plansCatalog: { provider_groups: [] } }) as unknown as AppContext;
const post = (body: unknown) => new Request("http://test/api/projects", { method: "POST", body: JSON.stringify(body) });
const json = async (response: Response | Promise<Response>) => {
  const resolved = await response;
  const body = await resolved.json() as Record<string, any>;
  expect(resolved.status, JSON.stringify(body)).toBe(200);
  return body;
};
const changes = (db: Database) => (db.query("SELECT total_changes() n").get() as { n: number }).n;

/** Calls per (project, day, vendor) the rules give the raw calls. */
/**
 * Calls per (project, day, vendor) the remap gave the raw calls: its CASE frozen in remap-project-oracle.ts, run by SQLite
 * on a scratch copy of the raw rows (independent of the resolver the readers use).
 */
function oracle(cfg: ProjectsConfig): Record<string, Array<[string, number, number]>> {
  const scratch = new Database(":memory:"), out: Record<string, Map<string, [number, number]>> = {};
  try {
    scratch.exec(`CREATE TABLE claude_events(store TEXT, cwd TEXT, project TEXT, repo TEXT, ts TEXT, project_id TEXT);
      CREATE TABLE events(home TEXT, cwd TEXT, project TEXT, repo TEXT, ts TEXT, project_id TEXT)`);
    // The fixture runs no repository remap: its calls carry no repository.
    for (const call of CALLS) scratch.query(`INSERT INTO ${call.table} VALUES(?, ?, ?, NULL, ?, NULL)`)
      .run(call.table === "events" ? CODEX : "live", call.cwd, call.project, call.ts);
    assignProjectsAsRemapDid(scratch, cfg, (_table, store) => [store]);
    for (const [table, vendor] of [["claude_events", 0], ["events", 1]] as const)
      for (const row of scratch.query(`SELECT ts, project_id FROM ${table}`).all() as Array<{ ts: string; project_id: string | null }>) {
        const id = row.project_id ?? "unassigned", days = out[id] ??= new Map(), day = days.get(row.ts.slice(0, 10)) ?? [0, 0];
        day[vendor]++;
        days.set(row.ts.slice(0, 10), day);
      }
  } finally { scratch.close(); }
  return Object.fromEntries(Object.entries(out).map(([id, days]) => [id, [...days].map(([day, [claude, codex]]) => [day, claude, codex] as [string, number, number])
    .sort((a, b) => a[0].localeCompare(b[0]))]));
}
async function reads(ctx: AppContext, ids: readonly string[]) {
  const out: Record<string, Array<[string, number, number]>> = {};
  for (const id of ids) {
    const summary = await json(handleSummary(ctx, new URL(`http://test/api/summary?vendor=both&group=day&project_id=${encodeURIComponent(id)}`)));
    const days = (summary.buckets as Array<Record<string, any>>).map(bucket => [bucket.bucket, bucket.claude?.calls ?? 0, bucket.codex?.calls ?? 0] as [string, number, number])
      .filter(([, claude, codex]) => claude + codex > 0);
    if (days.length) out[id] = days;
  }
  return out;
}

test("project rule changes through the API write nothing and every project read follows them at once", async () => {
  saveProjects({ projects: [{ id: "alpha", name: "Alpha", matches: [{ cwd: "C:/work/alpha" }] }, { id: "_tmp", name: "Tymczasowe", matches: [] }] });
  const db = database(), ctx = context(db), ids = ["alpha", "beta", "_tmp", "unassigned"];
  const queued = () => db.query("SELECT provider, kind, COUNT(*) n FROM usage_ledger_dirty GROUP BY 1, 2 ORDER BY 1, 2").all();
  const queue = queued(), written = changes(db);
  expect(await reads(ctx, ids)).toEqual(oracle(loadProjects()));

  // A folder added to a new project.
  await json(handleProjectsAssign(ctx, post({ new: { id: "beta", name: "Beta" }, match: { cwd: "C:/work/beta" } })));
  expect(changes(db)).toBe(written);
  expect(await reads(ctx, ids)).toEqual(oracle(loadProjects()));
  expect((await reads(ctx, ["beta"])).beta).toEqual([["2026-09-12", 1, 1], ["2026-09-13", 1, 1]]);

  // The alpha rule moved to `_tmp`.
  await json(handleProjectsReassign(ctx, post({ from: "alpha", index: 0, to: "_tmp" })));
  expect(changes(db)).toBe(written);
  expect(await reads(ctx, ids)).toEqual(oracle(loadProjects()));
  expect((await reads(ctx, ["_tmp"]))._tmp).toHaveLength(2);

  // A dated rule ahead of the folder rule: gamma's day and one beta day belong to alpha only within its dates.
  await json(handleProjectsUpdate(ctx, post({ project_id: "alpha", matches: [{ cwd: "C:/work", from: "2026-09-13", until: "2026-09-14" }] })));
  const cfg = loadProjects();
  expect(changes(db)).toBe(written);
  expect(await reads(ctx, ids)).toEqual(oracle(cfg));
  expect((await reads(ctx, ["alpha"])).alpha).toEqual([["2026-09-13", 1, 1]]);
  expect(queued()).toEqual(queue);
  expect(changes(db)).toBe(written);
});
