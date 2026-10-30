import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { databaseEnvironmentContents, databaseLocalStateRoot, localSettingsFile, saveDatabaseSelection, selectedDatabasePath } from "../db/location";
import { prepareLocalSettings, copyLocalState } from "./local-settings";
import { resolveLocalStateRootBase } from "./archive-locator";

test("the folder chosen at installation owns local state and uses application settings instead of env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-local-settings-"));
  try {
    const envFile = path.join(root, "app", ".env"), database = path.join(root, "chosen", "atlas.sqlite");
    const localAppData = path.join(root, "old"), old = path.join(localAppData, "tokenAtlas");
    fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "identity.sqlite"), "existing identity bytes");
    fs.writeFileSync(path.join(old, "temporary-storage.json"), '{"schema":1,"root":"fixture"}');
    fs.writeFileSync(envFile, databaseEnvironmentContents("PORT=7331\nOTHER=keep", database));
    const env = { ...process.env, TOKENATLAS_LOCAL_STATE: "", LOCALAPPDATA: localAppData };
    prepareLocalSettings(envFile, env);
    expect(selectedDatabasePath(envFile)).toBe(database.replace(/\\/g, "/"));
    expect(resolveLocalStateRootBase(env, selectedDatabasePath(envFile))).toBe(databaseLocalStateRoot(database));
    expect(fs.readFileSync(path.join(databaseLocalStateRoot(database), "identity.sqlite"), "utf8")).toBe("existing identity bytes");
    expect(fs.readFileSync(path.join(old, "identity.sqlite"), "utf8")).toBe("existing identity bytes");
    expect(fs.readFileSync(envFile, "utf8")).not.toContain("TOKENATLAS_DB=");
    expect(fs.readFileSync(envFile, "utf8")).toContain("OTHER=keep");
    const before = fs.statSync(localSettingsFile(envFile)).mtimeMs;
    prepareLocalSettings(envFile, env);
    expect(fs.statSync(localSettingsFile(envFile)).mtimeMs).toBe(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("a missing former directory does not fabricate an identity; an existing destination is preserved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-local-state-"));
  try {
    const old = path.join(root, "old"), next = path.join(root, "next");
    expect(copyLocalState(old, next)).toBe(false);
    expect(fs.existsSync(next)).toBe(false);
    fs.mkdirSync(old); fs.mkdirSync(next); fs.writeFileSync(path.join(next, "identity.sqlite"), "keep");
    expect(() => copyLocalState(old, next)).toThrow("already exists");
    expect(fs.readFileSync(path.join(next, "identity.sqlite"), "utf8")).toBe("keep");
    const envFile = path.join(root, ".env");
    saveDatabaseSelection(path.join(root, "chosen", "atlas.sqlite"), envFile);
    expect(fs.existsSync(envFile)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a database inside the former state folder is not copied into its own local state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-nested-state-"));
  try {
    const legacy = path.join(root, "tokenAtlas"), destination = path.join(legacy, "data", "local-state");
    fs.mkdirSync(path.join(legacy, "data"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "data", "atlas.sqlite"), "db");
    fs.writeFileSync(path.join(legacy, "archive-location.json"), "{}");
    expect(copyLocalState(legacy, destination)).toBe(true);
    expect(fs.readdirSync(destination).sort()).toEqual(["archive-location.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
