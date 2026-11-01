import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localStateRoot } from "../config/local-identity";

/**
 * The user's Pause of the import (TALK-001 D12). Machine-local and kept across restarts: a paused import
 * stays paused until Resume, so the app never starts copying again behind the user's back.
 */
const FILE = "import-paused.json";

export function importPaused(root = localStateRoot()): boolean {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8")) as { schema?: unknown; paused?: unknown };
    return stored.schema === 1 && stored.paused === true;
  } catch { return false; }
}

export function saveImportPaused(paused: boolean, root = localStateRoot()): boolean {
  const file = path.join(root, FILE);
  if (!paused) { fs.rmSync(file, { force: true }); return false; }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const candidate = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(candidate, JSON.stringify({ schema: 1, paused: true, at: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(candidate, file);
  } finally { fs.rmSync(candidate, { force: true }); }
  return true;
}
