import fs from "node:fs/promises";
import path from "node:path";

/** The first import of an empty database: when it started and how many source files it will copy. */
export interface FirstImport { started_at: string; source_files: number | null }

/**
 * Counts the regular files under the source roots, so the screen can estimate how long copying takes.
 * Reads directory entries only; an unreadable folder is skipped rather than failing the import.
 */
export async function countSourceFiles(roots: readonly { path: string }[]): Promise<number> {
  let files = 0;
  const visit = async (entry: string): Promise<void> => {
    let stat;
    try { stat = await fs.lstat(entry); } catch { return; }
    if (stat.isFile()) { files++; return; }
    if (!stat.isDirectory()) return;
    let names: string[];
    try { names = await fs.readdir(entry); } catch { return; }
    for (const name of names) await visit(path.join(entry, name));
  };
  for (const root of new Set(roots.map(root => path.resolve(root.path)))) await visit(root);
  return files;
}
