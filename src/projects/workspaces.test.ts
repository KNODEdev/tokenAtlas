import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import type { ProjectsConfig } from "./remap";
import { compileProjectResolver, projectCaseSql, PROJECT_TABLES } from "./resolve";
import { workspaceRules } from "./workspaces";

const ROOT = "H:/_Dev/repos/clients/Przech/mesFlow";
const config = (): ProjectsConfig => ({ projects: [{ id: "mesflow", name: "mesFlow", matches: [{ cwd: ROOT }] }] });
const paths = [
  ROOT, ROOT + "/.claude/worktrees/agent-deadbeef/apps/tablet",
  ROOT + "-wt/feature-branch", ROOT + "-wt-recent-contexts", ROOT + "-worktree-fix/src",
  "C:/Users/sample_a/.codex/worktrees/abcd/mesFlow", "C:/Users/sample_a/.codex/worktrees/ef12/mesFlow/src",
  "C:/Users/sample_a/Documents/Codex/2026-09-13/mesflow-execution-09b9224399",
  "C:/Users/sample_a/Documents/Codex/2026-09-13/mesflow-assessment-aa2b1bcbcb",
  "C:/Users/sample_a/Documents/Codex/2026-09-13/mesflow-bench-isolation-probe-2",
  "C:/Users/sample_a/AppData/Local/Temp/claude/H---Dev-repos-clients-Przech-mesFlow/uuid/scratchpad",
  "C:/Users/sample_a/AppData/Local/Temp/mesflow-ui-branch-ui-20260908",
  "/tmp/mesflow-review-random/src",
  "C:/Users/sample_a/.codex-mr/worktrees/abcd/mesFlow/src",
  "/tmp/claude-1000/H---Dev-repos-clients-Przech-mesFlow/id/scratchpad",
];
function compare(cfg: ProjectsConfig, cwd: string | null, want: string | null, store: string | null = null, day = "2026-10-15") {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE places(store TEXT,cwd TEXT,project TEXT,repo TEXT,day TEXT)");
    db.query("INSERT INTO places VALUES(?,?,NULL,NULL,?)").run(store, cwd, day);
    const resolver = compileProjectResolver(cfg, (_table, s) => [s]);
    for (const table of PROJECT_TABLES) {
      expect(resolver.resolve(table, { store, cwd, project: null, repo: null }, day)).toBe(want);
      const sql = projectCaseSql(cfg, (_table, s) => [s], table, { store: "store", cwd: "cwd", project: "project", repo: "repo", day: "day" });
      expect((db.query(`SELECT ${sql} id FROM places`).get() as { id: string | null }).id).toBe(want);
    }
  } finally { db.close(); }
}

test("agent workspaces and temporary task directories share the declared canonical project in JS and SQL", () => {
  for (const cwd of paths) {
    compare(config(), cwd, "mesflow");
    compare(config(), cwd.toUpperCase().replace(/\//g, "\\"), "mesflow");
  }
});
test("unrelated paths and similar project names are not inherited", () => {
  for (const cwd of [null, "", "C:/work/mesflow-execution-x", ROOT + "-other", ROOT + "Extra-wt-x",
    "C:/Users/a/Documents/Codex/2026-09-13/notmesflow-execution-abc", "/tmp/mesflow2-ui-branch-x",
    "/tmp/something/mesflow-ui-branch-x", "/tmp/mesflow-unrelated", "/tmp/claude/other-root/id/scratchpad"]) compare(config(), cwd, null);
});
test("explicit assignments including the temporary bucket take precedence over workspace inference", () => {
  const cfg = config();
  cfg.projects.push({ id: "_tmp", name: "_TMP", matches: [{ cwd: paths[7]! }] });
  compare(cfg, paths[7]!, "_tmp");
  const bucketOnly = { projects: [{ id: "_tmp", name: "_TMP", matches: [{ cwd: ROOT }] }] };
  compare(bucketOnly, paths[7]!, null);
});
test("ambiguous workspace names do not depend on declaration order", () => {
  const cfg = config();
  cfg.projects.push({ id: "other-mesflow", name: "Other", matches: [{ cwd: "D:/repos/clients/other/mesFlow" }] });
  compare(cfg, paths[7]!, null);
  cfg.projects.reverse();
  compare(cfg, paths[7]!, null);
  compare(cfg, ROOT + "-wt-exact", "mesflow");
});
test("store restrictions and raw-day intervals are inherited with the root", () => {
  const cfg = config();
  Object.assign(cfg.projects[0]!.matches[0]!, { store: "source-a", from: "2026-10-10", until: "2026-10-20" });
  compare(cfg, paths[7]!, null, "source-b");
  compare(cfg, paths[7]!, null, "source-a", "2026-10-09");
  compare(cfg, paths[7]!, "mesflow", "source-a", "2026-10-10");
  compare(cfg, paths[7]!, null, "source-a", "2026-10-20");
  expect(compileProjectResolver(cfg, (_t, s) => [s]).dated("events", { store: "source-a", cwd: paths[7]!, project: null, repo: null })).toBe(true);
});
test("package rules, glob rules and extra match restrictions do not become root aliases", () => {
  const cfg = config();
  cfg.projects[0]!.matches = [{ cwd: ROOT + "/src" }, { cwd: ROOT + "/*" }, { cwd: ROOT, project: "pinned" }];
  expect(workspaceRules(cfg)).toEqual([]);
});
