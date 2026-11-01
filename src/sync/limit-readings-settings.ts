import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localStateRoot } from "../config/local-identity";

/**
 * Whether this computer reads account limits from the providers (user decision TALK-001 D4: a toggle on the
 * first-run consent screen, changeable in Settings). Machine-local like the cloud interval. Off is a veto:
 * `TOKENATLAS_PROBE_MINUTES` only sets the interval while readings are on.
 */
const FILE = "limit-readings-settings.json";

export interface LimitReadingsSetting { enabled: boolean; source: "settings" | "default" }

export function readLimitReadingsSetting(root = localStateRoot()): LimitReadingsSetting {
  const file = path.join(root, FILE);
  if (!fs.existsSync(file)) return { enabled: true, source: "default" };
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: unknown; enabled?: unknown };
  if (stored.schema !== 1 || typeof stored.enabled !== "boolean") throw new Error("Invalid local limit readings setting.");
  return { enabled: stored.enabled, source: "settings" };
}

/** An unreadable file counts as off: a damaged choice never turns network reads back on. */
export function limitReadingsEnabled(root = localStateRoot()): boolean {
  try { return readLimitReadingsSetting(root).enabled; } catch { return false; }
}

export function saveLimitReadingsEnabled(enabled: unknown, root = localStateRoot()): LimitReadingsSetting {
  if (typeof enabled !== "boolean") throw new Error("Limit readings must be on or off.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, FILE), candidate = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(candidate, JSON.stringify({ schema: 1, enabled }) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(candidate, file);
  } finally { fs.rmSync(candidate, { force: true }); }
  return { enabled, source: "settings" };
}
