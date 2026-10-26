import path from "node:path";

export function isSourceConflict(file: string): boolean {
  return file.split(/[\/]/).some(part => /\.conflict-[a-f\d]{64}(?:\.|$)/i.test(part));
}

/**
 * Queued physical files, checked without enumerating any directory and without touching the
 * disk. Files reach an importer from the sync queue's listing, which proved each one an
 * ordinary file with no link below its archive root, so only what the path itself says is
 * checked here: that it lies below `root` and is not a conflict copy. A file that vanished
 * since is reported by the stat its importer takes to read it.
 */
export function exactFiles(files: string[], root?: string): string[] {
  const resolvedRoot = root === undefined ? undefined : path.resolve(root);
  return [...new Set(files.map(file => path.resolve(file)))].map(file => {
    if (resolvedRoot !== undefined) {
      const relative = path.relative(resolvedRoot, file);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Selected source is outside its root: ${file}`);
      }
    }
    if (isSourceConflict(file)) throw new Error(`Selected source is not an eligible archive file: ${file}`);
    return file;
  });
}
