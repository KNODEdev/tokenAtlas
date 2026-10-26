import { expect, test } from "bun:test";
import type { SourceProfileConfiguration, SourceProfileEdit } from "../shared/source-health";
import { prepareSourceProfileEdit } from "./source-profile";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const config: SourceProfileConfiguration = { revision: "v1", machine: "LAPTOP", login: "sample_a", resolved: [], declarations: [
  { vendor: "codex", machine: "MAIN", home: "C:/archive/MAIN-agy11", source_home: "C:/Users/sample_a/.codex-mr" },
  { vendor: "codex", machine: "LAPTOP", home: "C:/archive/LAPTOP", source_home: "C:/Users/sample_a/.codex" },
] };
const edit: SourceProfileEdit = { revision: "v1", index: null, subscription: "kuba", vendor: "codex", profile: "C:/Users/sample_a/.codex-mr", archive: "C:/archive/LAPTOP-mr" };

test("adding a source on a second PC preserves all existing declarations", () => {
  const result = prepareSourceProfileEdit(config, edit);
  expect(result.sources!.slice(0, 2)).toEqual(config.declarations);
  expect(result.sources![2]).toMatchObject({ machine: "LAPTOP", source_home: edit.profile, home: edit.archive });
  expect(result.expectedSourceRevision).toBe("v1");
  expect(config.declarations).toHaveLength(2);
});

test("the inline editor rejects stale config, remote edits, duplicate local profiles and ownership changes", () => {
  expect(() => prepareSourceProfileEdit(config, { ...edit, revision: "stale" })).toThrow("Konfiguracja zmieniła");
  expect(() => prepareSourceProfileEdit(config, { ...edit, index: 0 })).toThrow("jego komputerze");
  expect(() => prepareSourceProfileEdit(config, { ...edit, profile: "c:\\Users\\sample_a\\.codex" })).toThrow("już przypisany");
  expect(() => prepareSourceProfileEdit(config, { ...edit, index: 1 })).toThrow("zachowuje dostawcę i archiwum");
});

test("moving a local profile retains its archive and other PC without assigning an account", () => {
  const result = prepareSourceProfileEdit(config, { ...edit, index: 1, subscription: "other", archive: "C:/archive/LAPTOP" });
  expect(result.sources).toHaveLength(2);
  expect(result.sources![0]).toEqual(config.declarations[0]);
  expect(result.sources![1]).toMatchObject({ home: "C:/archive/LAPTOP", source_home: edit.profile });
  expect(result.subscriptions).toBeUndefined();
});

test("an unowned source can be edited without supplying a subscription", () => {
  const result = prepareSourceProfileEdit(config, { ...edit, subscription: "", index: 1, archive: "C:/archive/LAPTOP" });
  expect(result.sources![1]?.source_home).toBe(edit.profile);
  expect(result.subscriptions).toBeUndefined();
  expect(result.sources!.every(source => !("id" in source) && !("account" in source))).toBe(true);
});

test("focused save verifies profile identity and preserves unrelated configuration fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-source-editor-"));
  const profile = path.join(root, ".codex-mr"), directory = path.join(root, "config");
  fs.mkdirSync(profile); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(profile, "auth.json"), JSON.stringify({ tokens: { account_id: "fixture", access_token: "fixture",
    id_token: "h." + Buffer.from(JSON.stringify({ email: "kuba@example.test" })).toString("base64url") + ".s" } }));
  const original = { version: 2, custom: { retained: true }, subscriptions: [
    { id: "kuba", vendor: "codex", account: "kuba@example.test", note: "keep this" },
    { id: "hidden", vendor: "codex", custom: "metadata" },
  ], sources: [config.declarations[0]] };
  const accounts = path.join(directory, "accounts.json");
  fs.writeFileSync(accounts, JSON.stringify(original));
  const script = path.join(root, "save.ts");
  fs.writeFileSync(script, `
    import { Database } from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
    import { readSourceProfileConfiguration,prepareSourceProfileEdit } from ${JSON.stringify(path.join(import.meta.dir, "source-profile.ts"))};
    import { saveSetup } from ${JSON.stringify(path.join(import.meta.dir, "setup.ts"))};
    const db=new Database(":memory:");
    const config=readSourceProfileConfiguration(db);
    saveSetup(prepareSourceProfileEdit(config,{ revision:config.revision,index:null,subscription:"kuba",vendor:"codex",
      profile:${JSON.stringify(profile)},archive:${JSON.stringify(path.join(root, "archive", "LAPTOP-mr"))} }));
    db.close();
  `);
  try {
    const proc = Bun.spawn([process.execPath, script], { env: { ...process.env, TOKENATLAS_CONFIG: directory,
      TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_MACHINE: "LAPTOP", TOKENATLAS_LOGIN: "sample_a" }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect({ exit: await proc.exited, stderr }).toEqual({ exit: 0, stderr: "" });
    const saved = JSON.parse(fs.readFileSync(accounts, "utf8"));
    expect(saved.custom).toEqual(original.custom);
    expect(saved.subscriptions[0]).toEqual(original.subscriptions[0]);
    expect(saved.subscriptions.find((row: { id: string }) => row.id === "hidden")).toEqual(original.subscriptions[1]);
    expect(saved.sources.find((row: { machine: string }) => row.machine === "LAPTOP")).toMatchObject({ source_home: profile });
    expect(saved.sources.every((row: object) => !("id" in row) && !("account" in row))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("folder-backed providers save a local source, while managed IDs are not paths", () => {
  for (const vendor of ["claude", "grok", "gemini"]) {
    expect(prepareSourceProfileEdit(config, { ...edit, vendor }).sources!.at(-1)).toMatchObject({ vendor, source_home: edit.profile });
  }
  expect(() => prepareSourceProfileEdit(config, { ...edit, vendor: "glm" })).toThrow("folderu");
});

test("saving an AGY source keeps its declared account separate from Gemini CLI login", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-agy-source-"));
  const profile = path.join(root, ".gemini"), directory = path.join(root, "config");
  fs.mkdirSync(profile); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(profile, "google_accounts.json"), JSON.stringify({ active: "cli@example.test" }));
  const accounts = path.join(directory, "accounts.json"), archive = path.join(root, "archive", "gemini", "LAPTOP-sample_a");
  fs.writeFileSync(accounts, JSON.stringify({ version: 2,
    subscriptions: [{ id: "agy3", vendor: "gemini", account: "agy@example.test" }],
    sources: [{ vendor: "gemini", machine: "LAPTOP", login: "sample_a", home: archive }] }));
  const script = path.join(root, "save.ts");
  fs.writeFileSync(script, `
    import { Database } from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
    import { readSourceProfileConfiguration, prepareSourceProfileEdit } from ${JSON.stringify(path.join(import.meta.dir, "source-profile.ts"))};
    import { saveSetup } from ${JSON.stringify(path.join(import.meta.dir, "setup.ts"))};
    const db=new Database(":memory:"); const config=readSourceProfileConfiguration(db);
    saveSetup(prepareSourceProfileEdit(config,{revision:config.revision,index:0,subscription:"agy3",vendor:"gemini",profile:${JSON.stringify(profile)},archive:${JSON.stringify(archive)}})); db.close();
  `);
  try {
    const proc = Bun.spawn([process.execPath, script], { env: { ...process.env, TOKENATLAS_CONFIG: directory, TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_MACHINE: "LAPTOP", TOKENATLAS_LOGIN: "sample_a" }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect({ exit: await proc.exited, stderr }).toEqual({ exit: 0, stderr: "" });
    const saved = JSON.parse(fs.readFileSync(accounts, "utf8"));
    expect(saved.sources[0]).toMatchObject({ source_home: profile, home: archive });
    expect(saved.subscriptions).toEqual([{ id: "agy3", vendor: "gemini", account: "agy@example.test" }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
