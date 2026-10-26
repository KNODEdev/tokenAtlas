import path from "node:path";
import { ARCHIVE_ROOT } from "../src/config/paths";
import { activeDatabasePath } from "../src/db";
import { initializeArchiveWriterIdentity } from "../src/sync/archive-writers";
import { consolidateArchiveLayout } from "./migrations/archive-layout-migration";
import { consolidateArchiveProfiles } from "./migrations/archive-profile-consolidation";
import { finalizeClaudeProfiles } from "./migrations/finalize-claude-profiles";

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (!["apply", "merge-profiles", "finalize"].includes(args[0] ?? "")) throw new Error("Usage: bun scripts/archive-layout.ts apply|merge-profiles|finalize [--archive PATH] [--db FILE] [--state-dir PATH] [--hub-profile NAME] [--asus-profile NAME]");
    const values = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1];
      if (!["--archive", "--db", "--state-dir", "--hub-profile", "--asus-profile"].includes(key) || !value || values.has(key)) throw new Error(`Invalid option: ${key}`);
      values.set(key, value);
    }
    const database = path.resolve(values.get("--db") ?? activeDatabasePath());
    initializeArchiveWriterIdentity();
    const locations = { archiveRoot: path.resolve(values.get("--archive") ?? ARCHIVE_ROOT),
      database, stateDirectory: path.resolve(values.get("--state-dir") ?? path.join(path.dirname(database), "archive-layout")) };
    const result = args[0] === "finalize" ? finalizeClaudeProfiles(locations) : args[0] === "merge-profiles"
      ? consolidateArchiveProfiles({ ...locations,
        targets: Object.fromEntries(["hub", "asus"].filter(store => values.has(`--${store}-profile`))
          .map(store => [store, `claude/${values.get(`--${store}-profile`)}`])),
        progress: value => console.error(JSON.stringify(value)) })
      : consolidateArchiveLayout({ ...locations, progress: value => console.error(JSON.stringify(value)) });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
