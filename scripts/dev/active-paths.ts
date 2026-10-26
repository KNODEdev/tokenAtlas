import { CONFIG_ROOT } from "../../src/config/paths";
import { activeDatabasePath } from "../../src/db";

// Launcher scripts ask the app instead of repeating its defaults, so a location chosen in
// Settings reaches them too. Usage: bun scripts/dev/active-paths.ts database|config
const paths: Record<string, () => string> = { database: () => activeDatabasePath(), config: () => CONFIG_ROOT };
const read = paths[process.argv[2] ?? ""];
if (!read) {
  console.error("Usage: bun scripts/dev/active-paths.ts database|config");
  process.exit(2);
}
console.log(read());
