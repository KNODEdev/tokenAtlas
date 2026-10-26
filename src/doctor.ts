import fs from "node:fs";
import { configFile } from "./config/paths";
import { activeDatabasePath } from "./db";
import { isFirstRun, readAccountsV2 } from "./config/accounts-document";
import { readLocalArchiveSelection } from "./config/archive-locator";
import {
  ARCHIVE_ROOT,
  ARCHIVE_ROOT_IS_EXPLICIT,
  archiveProfiles,
  expandPath,
  home,
  LOGIN,
  MACHINE,
  PROFILE,
} from "./config/paths";
const OK = "[ok]";
const WARN = "[!]";
const BAD = "[X]";
let blocked = false;
let warned = false;
function ok(msg: string) {
  console.log(`${OK}   ${msg}`);
}
function warn(msg: string, hint?: string) {
  warned = true;
  console.log(`${WARN}    ${msg}`);
  if (hint) console.log(`      ${hint}`);
}
function bad(msg: string, hint?: string) {
  blocked = true;
  console.log(`${BAD}    ${msg}`);
  if (hint) console.log(`      ${hint}`);
}
function codexHomeIsDeclared(): boolean {
  const file = configFile("accounts.json");
  if (!fs.existsSync(file)) return false;
  const cfg = readAccountsV2(file);
  return cfg.sources.some(
      (s) =>
        s.vendor === "codex" &&
        typeof s.home === "string" &&
        expandPath(s.home).toLowerCase().endsWith(PROFILE.toLowerCase())
    );
}
function countRows(dbPath: string): Record<string, number> | null {
  if (!fs.existsSync(dbPath)) return null;
  const { Database } = require("./db/sqlite") as typeof import("./db/sqlite");
  const db = new Database(dbPath, { readonly: true });
  const out: Record<string, number> = {};
  for (const t of ["events", "claude_events", "oc_events", "grok_events", "gemini_events"]) {
    try {
      const row = db.query(process.argv.includes("--counts") ? `SELECT COUNT(*) AS n FROM ${t}` : `SELECT 1 AS n FROM ${t} LIMIT 1`).get() as { n: number } | null;
      out[t] = row?.n ?? 0;
    } catch {
      out[t] = 0;
    }
  }
  db.close();
  return out;
}
console.log("=== tokenAtlas - preflight ===\n");
console.log(`machine : ${MACHINE}`);
console.log(`login   : ${LOGIN}`);
console.log(`profile : ${PROFILE}   (how codex/grok/gemini partition the archive)`);
console.log("");
console.log(`archive : ${ARCHIVE_ROOT}`);
console.log(
  `source  : ${
    ARCHIVE_ROOT_IS_EXPLICIT ? "TOKENATLAS_ARCHIVE" : process.env.OneDrive ? "%OneDrive%" : "guessed from the home directory"
  }`
);
// A new machine has not chosen its archive yet; only a location it was given must exist.
const archiveIsGuessed = !ARCHIVE_ROOT_IS_EXPLICIT && !readLocalArchiveSelection();
if (!fs.existsSync(ARCHIVE_ROOT) && archiveIsGuessed && isFirstRun(configFile("accounts.json"), activeDatabasePath())) {
  warn(
    "first run: no archive chosen yet",
    "the app opens the setup wizard - there you connect the existing archive (OneDrive) or create a new one"
  );
} else if (!fs.existsSync(ARCHIVE_ROOT)) {
  bad(
    "archive root does not exist",
    ARCHIVE_ROOT_IS_EXPLICIT
      ? "fix TOKENATLAS_ARCHIVE in .env"
      : "set TOKENATLAS_ARCHIVE in .env (copy .env.example), or wait for OneDrive to finish signing in"
  );
} else {
  ok("archive root reachable");
  const vendors = ["codex", "claude", "grok", "gemini", "opencode"];
  for (const v of vendors) {
    const profiles = archiveProfiles(v);
    if (profiles.length === 0) {
      warn(`archive has no ${v} data yet`);
      continue;
    }
    const mine = profiles.includes(PROFILE) || profiles.includes(MACHINE);
    console.log(`      ${v}: ${profiles.join(", ")}${mine ? "" : "   (none of them is this machine)"}`);
  }
  if (!archiveProfiles("codex").some((p) => p === PROFILE || p === MACHINE)) {
    warn(
      "this machine has never mirrored into the archive",
      "that is expected on a first run - _sync.bat creates its folders. Until then the dashboard shows the OTHER machines' history."
    );
  } else if (!codexHomeIsDeclared()) {
    warn(
      `this machine's codex home is mirrored but its physical source is not declared in accounts.json`,
      `add a source with home "\${ARCHIVE}/codex/${PROFILE}" and source_home for this profile`
    );
  }
}
console.log("");
const sources: Array<[string, string]> = [
  ["codex", home(".codex", "sessions")],
  ["claude", home(".claude", "projects")],
  ["grok", home(".grok", "sessions")],
  ["gemini", home(".gemini", "antigravity-cli", "conversations")],
  ["opencode", home(".local", "share", "opencode", "opencode.db")],
];
console.log("live sources on this machine:");
for (const [name, p] of sources) {
  if (fs.existsSync(p)) console.log(`      ${OK} ${name.padEnd(9)} ${p}`);
  else console.log(`      -    ${name.padEnd(9)} (absent - nothing to mirror)`);
}
console.log("");
const dbPath = activeDatabasePath();
console.log(`index   : ${dbPath}`);
const counts = countRows(dbPath);
if (!counts) {
  warn("index does not exist yet", "_dev.bat creates it with `bun run db:migrate` before starting the server");
} else {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    warn("index is empty", "the server runs the first sync by itself on startup; `_sync.bat` does it now");
  } else {
    ok(
      "index populated: " +
        Object.entries(counts)
          .filter(([, n]) => n > 0)
          .map(([t, n]) => process.argv.includes("--counts") ? `${t}=${n.toLocaleString()}` : t)
          .join(", ")
    );
  }
}
console.log("");
if (blocked) {
  console.log(`${BAD}    preflight FAILED - fix the above before starting.`);
  process.exit(1);
}
console.log(warned ? `${WARN}    ready, with warnings.` : `${OK}   ready.`);
