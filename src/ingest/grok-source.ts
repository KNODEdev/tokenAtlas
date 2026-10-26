import path from "node:path";
import { createHash } from "node:crypto";

/** Identifies one retained archive profile, never an account. */
export function grokSourceIdentity(logicalRoot: string, options: { archiveRoot: string; archiveId: string }): string | null {
  const relative = path.relative(path.resolve(options.archiveRoot), path.resolve(logicalRoot)).split(path.sep).join("/");
  const parts = relative.split("/");
  if (parts[0] !== "grok" || !parts[1] || parts.includes("..")) return null;
  return `archive-source:${createHash("sha256").update(`${options.archiveId}\0grok/${parts[1]}`).digest("hex")}`;
}
