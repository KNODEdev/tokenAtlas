import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import catalog from "../plans-catalog.json";
import { publishDisplayPlanCatalog } from "../src/web/lib/plan-catalog";
import type { PlansCatalog } from "../src/web/lib/api/settings";

// Browser tests supply the catalog that production reads from /api/plans-catalog.
publishDisplayPlanCatalog(catalog as unknown as PlansCatalog);

// Tests and their child processes must never inherit the installation's live selections.
const inherited = process.env.TOKENATLAS_TEST_ROOT;
const relative = inherited ? path.relative(os.tmpdir(), inherited) : "";
if (!inherited || path.isAbsolute(relative) || relative.startsWith("..")
  || !path.basename(inherited).startsWith("tokenatlas-tests-")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-tests-"));
  process.env.TOKENATLAS_TEST_ROOT = root;
  for (const [key, directory] of Object.entries({
    TOKENATLAS_ARCHIVE: "archive",
    TOKENATLAS_CONFIG: "config",
    TOKENATLAS_LOCAL_STATE: "state",
    TOKENATLAS_SNAPSHOT_DIR: "snapshots",
  })) {
    const target = path.join(root, directory);
    fs.mkdirSync(target, { recursive: true });
    process.env[key] = target;
  }
  process.env.TOKENATLAS_DB = path.join(root, "test.sqlite");
}
