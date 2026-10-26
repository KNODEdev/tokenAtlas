import path from "node:path";

const [root, dbPath, repoRoot] = process.argv.slice(2);
if (!root || !dbPath || !repoRoot) throw new Error("runner environment fixture arguments missing");

const archiveRoot = path.join(root, "archive");
const configRoot = path.join(root, "config");
const homeRoot = path.join(root, "profiles", "user");
Object.assign(process.env, {
  TOKENATLAS_ARCHIVE: archiveRoot,
  TOKENATLAS_CONFIG: configRoot,
  TOKENATLAS_DB: dbPath,
  TOKENATLAS_MACHINE: "FIXTURE",
  TOKENATLAS_LOGIN: "user",
  TOKENATLAS_SYNC_MINUTES: "17",
  TOKENATLAS_PROBE_MINUTES: "0",
  TOKENATLAS_GEMINI_MINUTES: "0",
  USERPROFILE: homeRoot,
  HOME: homeRoot,
  APPDATA: path.join(homeRoot, "AppData", "Roaming"),
  OneDrive: path.join(root, "wrong-onedrive"),
});

const { runSyncProcess } = await import("../server/api");
const { Database } = await import("../db/sqlite");
const { ensureRawSyncIndexes } = await import("../db/migrate");
// The fixture bypasses startServer, so explicitly prepare its raw schema.
const initial = new Database(dbPath);
try { ensureRawSyncIndexes(initial); } finally { initial.close(); }
const result = await runSyncProcess(repoRoot, dbPath, {
  trigger: "manual",
  scope: { kind: "vendor", vendor: "codex" },
  mode: "incremental",
});
console.log(`RUNNER_ENV_RESULT:${JSON.stringify(result)}`);
