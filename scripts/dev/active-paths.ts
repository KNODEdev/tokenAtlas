import { CONFIG_ROOT, configFile } from "../../src/config/paths";
import { isFirstRun } from "../../src/config/accounts-document";
import { activeDatabasePath } from "../../src/db";
import fs from "node:fs";

// Launcher scripts ask the app instead of repeating its defaults, so a location chosen in
// Settings reaches them too. The first-run decision must precede database preparation.
const paths: Record<string, () => string> = {
  database: () => activeDatabasePath(), config: () => CONFIG_ROOT,
  "browser-ready": () => {
    const database = activeDatabasePath();
    return !fs.existsSync(database) || isFirstRun(configFile("accounts.json"), database) ? "setup" : "shell";
  },
};
const read = paths[process.argv[2] ?? ""];
if (!read) {
  console.error("Usage: bun scripts/dev/active-paths.ts database|config|browser-ready");
  process.exit(2);
}
console.log(read());
