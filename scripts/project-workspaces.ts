import fs from "node:fs";
import path from "node:path";
import { configFile } from "../src/config/paths";
import { compileProjectResolver } from "../src/projects/resolve";
import { loadProjects } from "../src/projects/remap";

// Explicitly requested history repair. Writes through the running application's API, never to the live database.
const args = process.argv.slice(2), id = args[args.indexOf("--project") + 1];
if (!args.includes("--project") || !id) throw new Error("Usage: bun scripts/project-workspaces.ts --project <id> [--query <text>] [--apply]");
const query = args.includes("--query") ? args[args.indexOf("--query") + 1]! : id;
const base = `http://127.0.0.1:${process.env.PORT || "7331"}`;
const get = async (url: string) => {
  const response = await fetch(base + url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<any>;
};
const cfg = loadProjects();
if (!cfg.projects.some(project => project.id === id)) throw new Error(`Unknown project ${id}`);
// A global directory alias is safe only for an unscoped target. Scoped repairs need an explicit rule design.
const target = cfg.projects.find(project => project.id === id)!;
if (target.matches.some(match => match.store || match.from || match.until || match.project || match.repo))
  throw new Error("Scoped project rules require a scoped repair; refusing global aliases");
const resolver = compileProjectResolver(cfg, (_table, store) => [store]);
const before = await get(`/api/projects/rows?q=${encodeURIComponent(query)}&limit=10000`);
if (before.rows.length !== before.total) throw new Error("Incomplete inventory; refusing a partial repair");
const recognized = before.rows.filter((row: any) => resolver.resolve(row.vendor === "codex" ? "events" : row.vendor === "claude" ? "claude_events" : row.vendor === "grok" ? "grok_events" : "oc_events",
  { store: row.store, cwd: row.cwd, project: row.project, repo: null }, row.first_ts.slice(0, 10)) === id &&
  resolver.resolve(row.vendor === "codex" ? "events" : row.vendor === "claude" ? "claude_events" : row.vendor === "grok" ? "grok_events" : "oc_events",
    { store: row.store, cwd: row.cwd, project: row.project, repo: null }, row.last_ts.slice(0, 10)) === id);
const summary = { project: id, apply: args.includes("--apply"), directories: recognized.length,
  calls: recognized.reduce((sum: number, row: any) => sum + row.calls, 0), tokens: recognized.reduce((sum: number, row: any) => sum + row.tokens, 0),
  unresolved: before.rows.length - recognized.length };
console.log(JSON.stringify(summary));
const directory = path.resolve("TMP", `project-workspaces-${id}-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, "before.json"), JSON.stringify(before, null, 2));
if (args.includes("--apply") && recognized.length) {
  fs.copyFileSync(configFile("projects.json"), path.join(directory, "projects.before.json"));
  const paths = [...new Set<string>(recognized.map((row: any) => row.cwd))];
  for (const cwd of paths) {
    if (!cwd) throw new Error("A confirmed directory is required");
    const response = await fetch(base + "/api/projects/assign", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: id, match: { cwd: cwd.replace(/\\/g, "/") } }), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Assign ${cwd}: HTTP ${response.status}: ${await response.text()}`);
  }
  const after = await get(`/api/projects/rows?q=${encodeURIComponent(query)}&limit=10000`);
  fs.writeFileSync(path.join(directory, "after.json"), JSON.stringify(after, null, 2));
  if (after.rows.some((row: any) => paths.includes(row.cwd))) throw new Error("Saved aliases are still unassigned");
  console.log(JSON.stringify({ remaining: after.total, evidence: directory }));
} else console.log(JSON.stringify({ evidence: directory }));
