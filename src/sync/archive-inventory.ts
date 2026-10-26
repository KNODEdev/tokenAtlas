import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicArchiveWrite } from "./archive-publication";
import { withArchiveWriter } from "./archive-writers";
import { readArchiveIdentity } from "./archive-local-state";

const ARCHIVE_IDENTITY_DIRECTORY = ".archive-inventory";

/** The shared archive retains only its stable identity; all derived inventory state is local. */
export function ensureArchiveIdentity(root: string): string {
  return withArchiveWriter(root, () => {
    if (!fs.statSync(root).isDirectory()) throw new Error("Archive root is not a directory");
    const file = path.join(root, ARCHIVE_IDENTITY_DIRECTORY, "identity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      const candidate = `${file}.${randomUUID()}.tmp`;
      try {
        atomicArchiveWrite(candidate, JSON.stringify({ schema: 1, archiveId: randomUUID() }));
        try { fs.linkSync(candidate, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { fs.rmSync(candidate, { force: true }); }
    }
    return readArchiveIdentity(root);
  });
}
