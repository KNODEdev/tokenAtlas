import fs from "node:fs";
import path from "node:path";

/** Target the journal descriptor, never an earlier coordination-file flush. */
export function interruptJournalFsync(file: string, interrupt: () => void): () => void {
  const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
  const descriptors = new Set<number>();
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const descriptor = open(...args);
    if (typeof args[0] === "string" && path.resolve(args[0]) === path.resolve(file)) descriptors.add(descriptor);
    return descriptor;
  }) as typeof fs.openSync;
  fs.closeSync = (descriptor) => {
    descriptors.delete(descriptor);
    return close(descriptor);
  };
  fs.fsyncSync = (descriptor) => {
    sync(descriptor);
    if (descriptors.has(descriptor)) interrupt();
  };
  return () => { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; };
}
