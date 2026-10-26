import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { removeTestFixture } from "../test-cleanup";

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });
function fixture(profiles = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-layout-")); fixtures.push(base);
  const root = path.join(base, "archive"); fs.mkdirSync(root);
  const env = { ...process.env, TOKENATLAS_ARCHIVE: root, TOKENATLAS_DB: path.join(base, "atlas.sqlite"),
    TOKENATLAS_CONFIG: path.join(base, "config"), TOKENATLAS_LOCAL_STATE: path.join(base, "local"),
    TOKENATLAS_STORE_LIVE: "", TOKENATLAS_STORE_HUB: "", TOKENATLAS_STORE_ASUS: "", TOKENATLAS_STORE_DESKTOP: "", LAYOUT_PROFILES: profiles ? "1" : "" };
  const run = (mode: string, extra: Record<string, string> = {}, expected = 0) => {
    const child = Bun.spawnSync([process.execPath, "src/sync/archive-layout-fixture.ts", mode], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== expected) throw new Error(`${mode}: ${child.exitCode}\n${child.stdout}\n${child.stderr}`);
  };
  return { base, root, env, run };
}
test("intermediate directory move preserves all source bytes and database rows", () => {
  const f = fixture(); f.run("seed"); f.run("move"); f.run("verify-move");
  fs.writeFileSync(path.join(f.base, "layout-state", JSON.parse(fs.readFileSync(path.join(f.root, ".archive-inventory/identity.json"), "utf8")).archiveId + ".json"), "corrupt");
  f.run("move");
}, 60000);
for (const boundary of ["fenced", "intent", "projects", "projectAsus", "complete"]) {
  test(`migration resumes a terminated process at ${boundary}`, () => {
    const f = fixture(); f.run("seed"); f.run("move", { LAYOUT_CRASH: boundary }, 77); f.run("move"); f.run("verify-move");
  }, 60000);
}
test("missing database is not created and does not move sources", () => {
  const f = fixture(); f.run("seed");
  const absent = path.join(f.base, "typo.sqlite"); f.run("move", { TOKENATLAS_DB: absent }, 1);
  expect(fs.existsSync(absent)).toBe(false); expect(fs.existsSync(path.join(f.root, "projects"))).toBe(true);
});
test("metadata hydration retries a full stable read but continuously changing sources stay unmoved", () => {
  const f = fixture(); f.run("seed");
  f.run("move", { LAYOUT_METADATA_CHANGE: "continuous" }, 1);
  expect(fs.existsSync(path.join(f.root, "projects"))).toBe(true);
  expect(fs.existsSync(path.join(f.root, ".archive-inventory/source-layout.json"))).toBe(false);
  f.run("move", { LAYOUT_METADATA_CHANGE: "once" }); f.run("verify-move");
}, 60000);
test("existing cloud provider directory does not require recursive mkdir", () => {
  const f = fixture(); f.run("seed"); f.run("move", { LAYOUT_EXISTING_PARENT: "1" }); f.run("verify-move");
}, 60000);
test("concurrent contenders cannot replace the resumable job, even with separate local state", async () => {
  const f = fixture(); f.run("seed");
  const ready = path.join(f.base, "ready");
  const otherDb = path.join(f.base, "other.sqlite"); fs.copyFileSync(f.env.TOKENATLAS_DB, otherDb);
  const child = Bun.spawn([process.execPath, "src/sync/archive-layout-fixture.ts", "move"], {
    env: { ...f.env, LAYOUT_CRASH: "fenced", LAYOUT_READY: ready }, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(25);
  expect(fs.existsSync(ready)).toBe(true);
  const extra = { TOKENATLAS_DB: otherDb, LAYOUT_STATE: path.join(f.base, "other-state") };
  f.run("move", extra, 1);
  expect(await child.exited).toBe(77);
  f.run("move", extra); f.run("verify-move");
}, 60000);
test("CLI resumes a published migration intent without importing analytical readers", () => {
  const f = fixture(); f.run("seed"); f.run("move", { LAYOUT_CRASH: "projects" }, 77);
  const child = Bun.spawnSync([process.execPath, "scripts/archive-layout.ts", "apply",
    "--archive", f.root, "--db", f.env.TOKENATLAS_DB, "--state-dir", path.join(f.base, "layout-state")],
    { env: f.env, stdout: "pipe", stderr: "pipe" });
  expect({ code: child.exitCode, error: child.stderr.toString().includes("unfinished") }, child.stderr.toString())
    .toEqual({ code: 0, error: false });
  f.run("verify-move");
}, 60000);
test("old and current histories share ordinary profiles without reimport; colliding attachments keep both versions", () => {
  const f=fixture(true); f.run("seed"); f.run("move"); f.run("merge"); f.run("finalize"); f.run("verify"); f.run("correct");
  f.run("finalize"); f.run("arrival");
},60000);
for (const boundary of ["fenced","intent","moved","cleaned","complete"]) {
  test(`profile consolidation resumes a terminated process at ${boundary}`, () => {
    const f=fixture(true); f.run("seed"); f.run("move"); f.run("merge",{PROFILE_CRASH:boundary},77); f.run("merge"); f.run("finalize"); f.run("verify");
  },60000);
}
test("transcript collision preserves both histories and does not publish a partial layout", () => {
  const f=fixture(true); f.run("seed"); f.run("move");
  const source=path.join(f.root,"claude/legacy-projects/session.jsonl");
  const conflict=path.join(f.root,"claude/PC-main/session.jsonl"); fs.writeFileSync(conflict,"different transcript\n");
  f.run("merge",{},1);
  expect(fs.existsSync(source)).toBe(true); expect(fs.readFileSync(conflict,"utf8")).toBe("different transcript\n");
  expect(JSON.parse(fs.readFileSync(path.join(f.root,".archive-inventory/source-layout.json"),"utf8")).schema).toBe(1);
});
for(const boundary of ["metadata","database","complete"]) {
  test(`canonical conversion resumes after termination at ${boundary}`,()=>{
    const f=fixture(true); f.run("seed"); f.run("move"); f.run("merge");
    f.run("finalize",{FINALIZE_CRASH:boundary},77); f.run("finalize"); f.run("verify");
  },60000);
}
test("identical attachments reuse a verified existing blob and preserve current profile files",()=>{
  const f=fixture(true),extra={LAYOUT_IDENTICAL_ATTACHMENT:"1"}; f.run("seed",extra); f.run("move");
  const content="preserved original attachment",digest=createHash("sha256").update(content).digest("hex");
  fs.mkdirSync(path.join(f.root,".source-versions/blobs"),{recursive:true});
  fs.writeFileSync(path.join(f.root,".source-versions/blobs",digest),content);
  f.run("merge"); f.run("finalize"); f.run("verify",extra);
  expect(fs.readFileSync(path.join(f.root,".source-versions/blobs",digest),"utf8")).toBe(content);
},60000);
test("invalid profile destinations fail before touching any source",()=>{
  const f=fixture(true); f.run("seed"); f.run("move");
  for(const target of ["claude/../outside","C:/outside",".source-versions/blobs/anything"]) f.run("merge",{PROFILE_TARGET_HUB:target},1);
  expect(fs.existsSync(path.join(f.root,"claude/legacy-projects/session.jsonl"))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.root,".archive-inventory/source-layout.json"),"utf8")).schema).toBe(1);
},60000);
