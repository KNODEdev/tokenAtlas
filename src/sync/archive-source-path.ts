import { JOURNAL_FILE_PATH } from "../providers/core/journal-files";
import path from "node:path";
import { archiveCodecSource } from "../shared/archive-codec-path";
import { VENDOR_IDS } from "./contracts";

export function assertSafeArchiveRelative(relative: string): string {
  if (!relative || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error(`Unsafe archive path: ${relative}`);
  }
  return relative;
}

export function isArchiveConflictSource(relative: string): boolean {
  return /\.conflict-[a-f0-9]{64}(?:\.|$)/i.test(relative);
}

export function isRecoverableArchiveSource(relative: string): boolean {
  const [vendor] = assertSafeArchiveRelative(relative).split("/");
  if (!VENDOR_IDS.includes(vendor as typeof VENDOR_IDS[number])) return false;
  if (isArchiveConflictSource(relative)) return false;
  if (archiveCodecSource(relative)) return true;
  if (vendor === "gauges") return JOURNAL_FILE_PATH.test(relative);
  if (vendor === "opencode") return /\/opencode\.(sqlite|db)$/.test(relative);
  if (vendor === "gemini") return /\/conversations\/[^/]+\.db$/.test(relative) || /\/history\.jsonl$/.test(relative);
  if (vendor === "codex" && /^codex\/[^/]+\/(?:sessions|archived_sessions)\/.+\.jsonl\.zst$/i.test(relative)) return true;
  return /\.(json|jsonl)$/.test(relative) && !/(^|\/)(auth|credentials|settings|config)\.json$/.test(relative);
}

export function containedArchivePath(root: string, relative: string): string {
  assertSafeArchiveRelative(relative);
  const result = path.resolve(root, ...relative.split("/"));
  const relation = path.relative(path.resolve(root), result);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`Unsafe archive path: ${relative}`);
  return result;
}
