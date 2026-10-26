/**
 * A cwd rule matches exactly what the remap's assignment matched with SQLite's GLOB (the frozen CASE of
 * remap-project-oracle.ts, run by real SQLite): well-formed and malformed classes, ranges and wildcards; no pattern
 * projects.json validation accepts makes compilation throw.
 */
import { expect, test } from "bun:test";
import { Database as AtlasDatabase } from "../db/sqlite";
import { validateProjects } from "./remap";
import { assignProjectsAsRemapDid } from "./remap-project-oracle";
import { compileProjectResolver } from "./resolve";

const PATTERNS = ["[abc", "[z-a]", "[a-c]", "[^a-c]", "[]]", "[]a]", "[^]]", "[a-]", "[-a]", "a[", "*[", "*[a", "[*]", "[?]", "*[ab]*",
  "c:/work/[ab]*", "c:/work/*", "?", "??", "*", "**", "*?", "[^]", "[]", "[[]", "a]", "[a-c-e]", "[!a]", "*/clients/*/web*", "c:/w[o-p]rk/*",
  "\\[a]", "[ż]", "*ł*", "[a-ż]"];
const STRINGS = ["a", "b", "c", "d", "z", "]", "[", "-", "^", "!", "*", "?", "[abc", "[z-a]", "ab", "abc", "", "a]", "[a]", "c:/work/a",
  "c:/work/b1", "c:/work/c", "c:/work", "x/clients/acme/website", "c:/work/x", "ż", "łódź", "ab[", "c:/wprk/a", "\\a"];

test("cwd glob rules match exactly as SQLite GLOB, malformed patterns included", () => {
  const db = new AtlasDatabase(":memory:");
  db.exec("CREATE TABLE events(home TEXT, cwd TEXT, project TEXT, repo TEXT, ts TEXT, project_id TEXT)");
  const insert = db.query("INSERT INTO events VALUES(NULL, ?, NULL, NULL, '2026-10-01T00:00:00Z', NULL)");
  for (const value of STRINGS) insert.run(value);
  const differences: unknown[] = [];
  for (const pattern of PATTERNS) {
    const cfg = { projects: [{ id: "p", name: "P", matches: [{ cwd: pattern }] }] };
    expect(validateProjects(cfg)).toEqual([]);
    assignProjectsAsRemapDid(db, cfg, (_table, store) => [store]);
    const resolver = compileProjectResolver(cfg, (_table, store) => [store]);
    for (const { cwd, project_id } of db.query("SELECT cwd, project_id FROM events").all() as Array<{ cwd: string; project_id: string | null }>) {
      const got = resolver.resolve("events", { store: null, cwd, project: null, repo: null }, "2026-10-01");
      if (got !== project_id) differences.push({ pattern, cwd, sqlite: project_id, resolver: got });
    }
  }
  db.close();
  expect(differences).toEqual([]);
});
