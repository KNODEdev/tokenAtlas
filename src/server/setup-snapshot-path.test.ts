import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtlasSnapshotPoolLocationError } from "../config/paths";
import { saveSetup } from "./setup";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Machine snapshot directory setting", () => {
  test("persists a local override for the active database and rejects OneDrive", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-setting-"));
    created.push(root);
    const database = path.join(root, "database", "atlas.sqlite");
    const config = path.join(root, "config");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
    const snapshot = path.join(root, "snapshots");
    const oneDrive = path.join(root, "OneDrive");
    const envFile = path.join(root, ".env");
    const previousConfig = process.env.TOKENATLAS_CONFIG;
    const previousSnapshot = process.env.TOKENATLAS_SNAPSHOT_DIR;
    const previousOneDrive = process.env.OneDrive;
    delete process.env.TOKENATLAS_CONFIG;
    delete process.env.TOKENATLAS_SNAPSHOT_DIR;
    process.env.OneDrive = oneDrive;
    try {
      const result = saveSetup(
        { config, snapshot, sources: [] },
        { envFile, dbPath: database },
      );

      expect(result.restart_required).toBe(true);
      expect(fs.readFileSync(envFile, "utf8")).toContain(`TOKENATLAS_SNAPSHOT_DIR=${snapshot}`);
      expect(() => saveSetup(
        {
          config,
          snapshot: path.join(oneDrive, "snapshots"),
          sources: [],
        },
        { envFile, dbPath: database },
      )).toThrow(AtlasSnapshotPoolLocationError);
    } finally {
      if (previousConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = previousConfig;
      if (previousSnapshot === undefined) delete process.env.TOKENATLAS_SNAPSHOT_DIR;
      else process.env.TOKENATLAS_SNAPSHOT_DIR = previousSnapshot;
      if (previousOneDrive === undefined) delete process.env.OneDrive;
      else process.env.OneDrive = previousOneDrive;
    }
  });
});
