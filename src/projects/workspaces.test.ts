import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import type { ProjectsConfig } from "./remap";
import { compileProjectResolver, projectCaseSql, PROJECT_TABLES } from "./resolve";
import { workspaceRules } from "./workspaces";

const ROOT = "C:/example/repos/clients/example-client/SampleApp";
const config = (): ProjectsConfig => ({ projects: [{ id: "sampleapp", name: "SampleApp", matches: [{ cwd: ROOT }] }] });
const paths = [
  ROOT, ROOT + "/.claude/worktrees/agent-deadbeef/apps/tablet",
  ROOT + "-wt/feature-branch", ROOT + "-wt-recent-contexts", ROOT + "-worktree-fix/src",
  "C:/Users/example/.codex/worktrees/abcd/SampleApp", "C:/Users/example/.codex/worktrees/ef12/SampleApp/src",
  "C:/Users/example/Documents/Codex/2026-09-13/sampleapp-execution-09b9224399",
  "C:/Users/example/Documents/Codex/2026-09-13/sampleapp-assessment-aa2b1bcbcb",
  "C:/Users/example/Documents/Codex/2026-09-13/sampleapp-bench-isolation-probe-2",
  "C:/Users/example/AppData/Local/Temp/claude/C--example-repos-clients-example-client-SampleApp/uuid/scratchpad",
  "C:/Users/example/AppData/Local/Temp/sampleapp-ui-branch-ui-20260908",
  "/tmp/sampleapp-review-random/src",
  "C:/Users/example/.codex-mr/worktrees/abcd/SampleApp/src",
  "/tmp/claude-1000/C--example-repos-clients-example-client-SampleApp/id/scratchpad",
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
    compare(config(), cwd, "sampleapp");
    compare(config(), cwd.toUpperCase().replace(/\//g, "\\"), "sampleapp");
  }
});
test("unrelated paths and similar project names are not inherited", () => {
  for (const cwd of [null, "", "C:/work/sampleapp-execution-x", ROOT + "-other", ROOT + "Extra-wt-x",
    "C:/Users/a/Documents/Codex/2026-09-13/notsampleapp-execution-abc", "/tmp/sampleapp2-ui-branch-x",
    "/tmp/something/sampleapp-ui-branch-x", "/tmp/sampleapp-unrelated", "/tmp/claude/other-root/id/scratchpad"]) compare(config(), cwd, null);
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
  cfg.projects.push({ id: "other-sampleapp", name: "Other", matches: [{ cwd: "D:/example/repos/clients/other-client/SampleApp" }] });
  compare(cfg, paths[7]!, null);
  cfg.projects.reverse();
  compare(cfg, paths[7]!, null);
  compare(cfg, ROOT + "-wt-exact", "sampleapp");
});
test("store restrictions and raw-day intervals are inherited with the root", () => {
  const cfg = config();
  Object.assign(cfg.projects[0]!.matches[0]!, { store: "source-a", from: "2026-10-10", until: "2026-10-20" });
  compare(cfg, paths[7]!, null, "source-b");
  compare(cfg, paths[7]!, null, "source-a", "2026-10-09");
  compare(cfg, paths[7]!, "sampleapp", "source-a", "2026-10-10");
  compare(cfg, paths[7]!, null, "source-a", "2026-10-20");
  expect(compileProjectResolver(cfg, (_t, s) => [s]).dated("events", { store: "source-a", cwd: paths[7]!, project: null, repo: null })).toBe(true);
});
test("package rules, glob rules and extra match restrictions do not become root aliases", () => {
  const cfg = config();
  cfg.projects[0]!.matches = [{ cwd: ROOT + "/src" }, { cwd: ROOT + "/*" }, { cwd: ROOT, project: "pinned" }];
  expect(workspaceRules(cfg)).toEqual([]);
});
