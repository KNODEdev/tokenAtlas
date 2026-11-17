import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleProjectsAssign, handleProjectsReassign } from "./api-projects";
import type { AppContext } from "./app-context-types";
import { removeTestFixture } from "../test-cleanup";

const ctx = {} as AppContext;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTestFixture(dir, { recursive: true, force: true }); });

function fixture(projects: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-bulk-"));
  dirs.push(dir);
  const file = path.join(dir, "projects.json");
  fs.writeFileSync(file, JSON.stringify({ projects }));
  return file;
}
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8")).projects as Array<{ id: string; name: string; matches: unknown[] }>;

describe("bulk project rules", () => {
  test("assign saves several rules to a new project in one write and keeps repeats once", async () => {
    const file = fixture([]);
    const res = await handleProjectsAssign(ctx, post({
      matches: [{ cwd: "C:/a/one" }, { cwd: "C:/a/two" }, { cwd: "C:/a/one" }],
      new: { id: "both", name: "Both" },
    }), file);
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(2);
    expect(read(file)).toEqual([{ id: "both", name: "Both", matches: [{ cwd: "C:/a/one" }, { cwd: "C:/a/two" }] }]);
  });

  test("assign rejects the whole list when one rule has no place", async () => {
    const file = fixture([{ id: "p", name: "P", matches: [] }]);
    const res = await handleProjectsAssign(ctx, post({ matches: [{ cwd: "C:/a" }, { store: "s" }], project_id: "p" }), file);
    expect(res.status).toBe(400);
    expect(read(file)[0]!.matches).toEqual([]);
  });

  test("the single `match` still works", async () => {
    const file = fixture([{ id: "p", name: "P", matches: [] }]);
    const res = await handleProjectsAssign(ctx, post({ match: { cwd: "C:/a" }, project_id: "p" }), file);
    expect(res.status).toBe(200);
    expect(read(file)[0]!.matches).toEqual([{ cwd: "C:/a" }]);
  });

  test("reassign moves several bucket rules and drops the emptied bucket", async () => {
    const file = fixture([{ id: "_tmp", name: "_TMP", matches: [{ cwd: "C:/a" }, { cwd: "C:/b" }] }, { id: "p", name: "P", matches: [] }]);
    const res = await handleProjectsReassign(ctx, post({ from: "_tmp", matches: [{ cwd: "C:\\a" }, { cwd: "C:/b" }], to: "p", drop_empty: true }), file);
    expect(res.status).toBe(200);
    expect(read(file)).toEqual([{ id: "p", name: "P", matches: [{ cwd: "C:/a" }, { cwd: "C:/b" }] }]);
  });

  test("reassign saves nothing when one rule is missing", async () => {
    const file = fixture([{ id: "_tmp", name: "_TMP", matches: [{ cwd: "C:/a" }] }]);
    const res = await handleProjectsReassign(ctx, post({ from: "_tmp", matches: [{ cwd: "C:/a" }, { cwd: "C:/zzz" }], drop_empty: true }), file);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("C:/zzz");
    expect(read(file)[0]!.matches).toEqual([{ cwd: "C:/a" }]);
  });
});
