import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localStateRoot } from "../config/local-identity";

/**
 * The user's Pause of the import (TALK-001 D12). Machine-local and kept across restarts: a paused import
 * stays paused until Resume, so the app never starts copying again behind the user's back.
 */
const FILE = "import-paused.json";

/** Only a missing file means "not paused": an unreadable or damaged one keeps the import stopped until Resume rewrites it. */
export function importPaused(root = localStateRoot()): boolean {
  const file = path.join(root, FILE);
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  try {
    const stored = JSON.parse(text) as { schema?: unknown; paused?: unknown };
    return stored.schema !== 1 || stored.paused !== false;
  } catch { return true; }
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
