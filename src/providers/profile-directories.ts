import fs from "node:fs";
import path from "node:path";

/** Scan only immediate profile directories; never recurse into caches or projects. */
export function profileDirectories(root: string, prefix: ".codex" | ".claude" | ".grok" | ".gemini"): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
      .map(entry => path.join(root, entry.name)).sort();
  } catch { return []; }
}
