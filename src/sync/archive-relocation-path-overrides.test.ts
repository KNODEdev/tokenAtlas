import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { createTestDatabase } from "./test-support";
import { ensureArchiveIdentity } from "./archive-inventory";
import {
  activateArchiveRelocation,
  advanceArchiveRelocation,
  startArchiveRelocation,
  type ArchiveRelocationState,
} from "./archive-relocation";
import {
  ARCHIVE_RELOCATION_OWNER_FILE,
  ARCHIVE_WRITERS_DIRECTORY,
  initializeArchiveWriterIdentity,
} from "./archive-writers";
import { readLocalArchiveSelection } from "../config/archive-locator";
import {
  resolveConfigRootFromEnvironment,
  resolveOverridePhysicalPathFromEnv,
} from "../config/path-environment";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) removeTestFixture(root, { recursive: true, force: true });
});

function fixture() {
  const created = createTestDatabase();
  temporary.push(created.directory);
  const base = created.directory;
  const first = path.join(base, "archive-a");
  const second = path.join(base, "archive-b");
  const third = path.join(base, "archive-c");
  const localState = path.join(base, "local-state");
  fs.mkdirSync(path.join(first, "claude", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(first, "claude", "fixture", "events.jsonl"), "{\"tokens\":7}\n");
  const archiveId = ensureArchiveIdentity(first);
  const db = new Database(created.dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.query("INSERT INTO meta(key,value) VALUES('archive:identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(archiveId);
  } finally {
    db.close();
  }
  const env = {
    ...process.env,
    TOKENATLAS_LOCAL_STATE: localState,
    TOKENATLAS_ARCHIVE: undefined,
    TOKENATLAS_CONFIG: undefined,
    TOKENATLAS_STORE_LIVE: undefined,
    TOKENATLAS_STORE_DESKTOP: undefined,
  };
  return {
    base,
    first,
    second,
    third,
    localState,
    database: created.dbPath,
    archiveId,
    firstState: path.join(base, "first-state"),
    secondState: path.join(base, "second-state"),
    env,
  };
}

async function ready(
  source: string,
  destination: string,
  stateDirectory: string,
): Promise<ArchiveRelocationState> {
  let state = startArchiveRelocation(source, destination, { stateDirectory });
  for (let step = 0; state.phase !== "ready-to-switch" && step < 100; step++) {
    state = await advanceArchiveRelocation(state.jobId, {
      stateDirectory,
      maxFiles: 4,
      maxBytes: 1024 * 1024,
    });
  }
  expect(state.phase).toBe("ready-to-switch");
  return state;
}

async function environment<T>(
  localState: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const prior = process.env.TOKENATLAS_LOCAL_STATE;
  process.env.TOKENATLAS_LOCAL_STATE = localState;
  try {
    initializeArchiveWriterIdentity();
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
    else process.env.TOKENATLAS_LOCAL_STATE = prior;
  }
}

function stateBytes(stateDirectory: string, jobId: string): Buffer {
  return fs.readFileSync(path.join(stateDirectory, `${jobId}.json`));
}

function treeSnapshot(root: string): Array<[string, string]> {
  if (!fs.existsSync(root)) return [];
  const result: Array<[string, string]> = [];
  const visit = (directory: string, prefix: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else result.push([relative, fs.readFileSync(absolute).toString("base64")]);
    }
  };
  visit(root, "");
  return result;
}

function fenceSnapshot(...roots: string[]): Array<[string, Array<[string, string]>]> {
  return roots.map(root => [root, treeSnapshot(path.join(root, ARCHIVE_WRITERS_DIRECTORY))]);
}

for (const kind of ["original-logical", "external"] as const) {
  test(`first activation permits ${kind} configuration`, async () => {
    const f = fixture();
    const state = await ready(f.first, f.second, f.firstState);
    const configured = kind === "original-logical"
      ? path.join(f.first, "config")
      : path.join(f.base, "external-config");
    const env = { ...f.env, TOKENATLAS_CONFIG: configured };
    expect(resolveConfigRootFromEnvironment(env, f.second)).toBe(
      kind === "original-logical" ? path.join(f.second, "config") : configured,
    );
    await environment(f.localState, () => activateArchiveRelocation(state.jobId, {
      stateDirectory: f.firstState,
      database: f.database,
      env,
    }));
    expect(readLocalArchiveSelection(env)).toEqual({ root: f.second, archiveId: f.archiveId });
  });
}

test("second activation refuses source-bound config and store overrides before durable mutation", async () => {
  const f = fixture();
  const first = await ready(f.first, f.second, f.firstState);
  await environment(f.localState, () => activateArchiveRelocation(first.jobId, {
    stateDirectory: f.firstState,
    database: f.database,
    env: { ...f.env, TOKENATLAS_CONFIG: path.join(f.first, "config") },
  }));
  const second = await ready(f.second, f.third, f.secondState);
  const sourceAlias = path.join(f.base, "archive-b-alias");
  fs.symlinkSync(f.second, sourceAlias, process.platform === "win32" ? "junction" : "dir");
  try {
    const beforeState = stateBytes(f.secondState, second.jobId);
    const beforeLocator = treeSnapshot(f.localState);
    const beforeFences = fenceSnapshot(f.second, f.third);
    const refusals: Array<[string, Record<string, string | undefined>]> = [
      ["TOKENATLAS_CONFIG", { TOKENATLAS_CONFIG: path.join(f.second, "config") }],
      ["TOKENATLAS_CONFIG", { TOKENATLAS_CONFIG: path.join(sourceAlias, "config") }],
      ["TOKENATLAS_STORE_LIVE", { TOKENATLAS_STORE_LIVE: path.join(f.second, "claude", "fixture") }],
      ["TOKENATLAS_STORE_DESKTOP", { TOKENATLAS_STORE_DESKTOP: path.join(f.second, "claude", "fixture-desktop") }],
    ];
    for (const [name, override] of refusals) {
      const env = { ...f.env, ...override };
      await expect(environment(f.localState, () => activateArchiveRelocation(second.jobId, {
        stateDirectory: f.secondState,
        database: f.database,
        env,
      }))).rejects.toThrow(`${name} resolves inside the retiring archive source`);
      expect(stateBytes(f.secondState, second.jobId)).toEqual(beforeState);
      expect(treeSnapshot(f.localState)).toEqual(beforeLocator);
      expect(fenceSnapshot(f.second, f.third)).toEqual(beforeFences);
      expect(fs.existsSync(path.join(f.third, ARCHIVE_RELOCATION_OWNER_FILE))).toBe(true);
    }

    const accepted = {
      ...f.env,
      TOKENATLAS_STORE_LIVE: "${ARCHIVE}/claude/fixture",
      TOKENATLAS_STORE_DESKTOP: "${ARCHIVE}/claude/fixture-desktop",
    };
    for (const [name,profile] of [
      ["TOKENATLAS_STORE_LIVE","fixture"],
      ["TOKENATLAS_STORE_DESKTOP","fixture-desktop"],
    ] as const) {
      expect(resolveOverridePhysicalPathFromEnv(accepted[name]!, accepted, f.third))
        .toBe(path.join(f.third, "claude",profile));
    }
    await environment(f.localState, () => activateArchiveRelocation(second.jobId, {
      stateDirectory: f.secondState,
      database: f.database,
      env: accepted,
    }));
    expect(readLocalArchiveSelection(accepted)).toEqual({ root: f.third, archiveId: f.archiveId });
  } finally {
    fs.unlinkSync(sourceAlias);
  }
}, 60000);
