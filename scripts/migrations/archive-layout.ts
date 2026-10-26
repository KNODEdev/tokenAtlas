import fs from "node:fs";
import path from "node:path";

// Offline migration evidence only; never imported by the running application.
export const ARCHIVE_LAYOUT_FILE = ".archive-inventory/source-layout.json";
export const LEGACY_ARCHIVE_FOLDERS = [
  { logical: "projects", physical: "claude/legacy-projects", store: "hub" },
  { logical: "projectAsus", physical: "claude/legacy-projectAsus", store: "asus" },
] as const;
export interface ArchiveLayout {
  schema: 1 | 2;
  archiveId: string;
  jobId: string;
  phase: "moving" | "complete";
  entries: Array<{ logical: string; physical: string; store: string }>;
  files?: Array<{ logical: string; physical: string }>;
}
const cache = new Map<string, { stamp: string; layout: ArchiveLayout }>();
const indexes = new WeakMap<ArchiveLayout, { forward: Map<string, string>; reverse: Map<string, { logical: string; store: string }> }>();
const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const safeRelative = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && !/[\\:\0\r\n]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
export function validateArchiveLayout(value: ArchiveLayout, archiveId: string): ArchiveLayout {
  if (!value || ![1, 2].includes(value.schema) || value.archiveId !== archiveId || !/^[a-zA-Z0-9_-]+$/.test(value.archiveId)
    || !/^[a-f0-9-]{36}$/i.test(value.jobId) || !["moving", "complete"].includes(value.phase)
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > LEGACY_ARCHIVE_FOLDERS.length
    || value.entries.some(e => !e || !LEGACY_ARCHIVE_FOLDERS.some(known => known.logical === e.logical && known.store === e.store)
      || (value.schema === 1 ? !LEGACY_ARCHIVE_FOLDERS.some(known => known.logical === e.logical && known.physical === e.physical)
        : !safeRelative(e.physical) || !/^claude\/[^/]+$/.test(e.physical) || /\/legacy-/i.test(e.physical)))
    || new Set(value.entries.map(e => key(e.logical))).size !== value.entries.length) throw new Error("Invalid archive source layout");
  if (value.schema === 2) {
    if (!Array.isArray(value.files)) throw new Error("Invalid archive source layout files");
    const forward = new Map<string, string>(), reverse = new Map<string, { logical: string; store: string }>();
    for (const file of value.files) {
      if (!file || !safeRelative(file.logical) || !safeRelative(file.physical)) throw new Error("Invalid archive source path");
      const entry = value.entries.find(e => file.logical.startsWith(e.logical + "/"));
      const retained = /^\.source-versions\/blobs\/[a-f0-9]{64}$/.test(file.physical);
      if (!entry || (retained ? file.logical.endsWith(".jsonl") : file.physical !== entry.physical + file.logical.slice(entry.logical.length))
        || forward.has(key(file.logical)) || (!retained && reverse.has(key(file.physical)))) throw new Error("Ambiguous archive source identity");
      forward.set(key(file.logical), file.physical);
      if (!retained) reverse.set(key(file.physical), { logical: file.logical, store: entry.store });
    }
    indexes.set(value, { forward, reverse });
  }
  return value;
}

/** A directory layout changes I/O locations, never the identity of an accepted fact. */
export function readArchiveLayout(root: string, allowMoving = false): ArchiveLayout | null {
  const file = path.join(root, ARCHIVE_LAYOUT_FILE);
  let stat: fs.Stats;
  try { stat = fs.statSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { cache.delete(file); return null; } throw error; }
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  let layout = cache.get(file)?.stamp === stamp ? cache.get(file)!.layout : undefined;
  if (!layout) {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as ArchiveLayout;
    const identity = JSON.parse(fs.readFileSync(path.join(root, ".archive-inventory/identity.json"), "utf8"));
    layout = validateArchiveLayout(value, identity.archiveId);
    cache.set(file, { stamp, layout });
  }
  if (layout.phase !== "complete" && !allowMoving) throw new Error("Archive source layout migration is unfinished; resume archive-layout before importing sources");
  return layout;
}

function replacePrefix(root: string, candidate: string, physical: boolean): string {
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), absolute).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return absolute;
  const layout = readArchiveLayout(root);
  if (layout?.schema === 2) {
    const index = indexes.get(layout)!;
    const mapped = physical ? index.forward.get(key(relative)) : index.reverse.get(key(relative))?.logical;
    if (mapped) return path.join(root, mapped);
    if (!physical) return absolute;
  }
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  for (const entry of layout?.entries ?? []) {
    const from = physical ? entry.logical : entry.physical;
    if (normalize(relative) === normalize(from) || normalize(relative).startsWith(normalize(from) + "/")) {
      return path.join(root, physical ? entry.physical : entry.logical, relative.slice(from.length));
    }
  }
  return absolute;
}
export const archiveLayoutPhysicalPath = (root: string, candidate: string): string => replacePrefix(root, candidate, true);
export const archiveLayoutLogicalPath = (root: string, candidate: string): string => replacePrefix(root, candidate, false);

export function isLegacyArchiveProfile(root: string, vendor: string, profile: string): boolean {
  const layout = readArchiveLayout(root);
  return layout?.schema === 1 && layout.entries.some(entry => entry.physical === `${vendor}/${profile}`);
}

/** Merged files retain their accepted accounting identity; new files use the ordinary profile. */
export function archiveLayoutSourceStore(root: string, file: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join("/");
  if (!relative.startsWith("claude/")) return undefined;
  const layout = readArchiveLayout(root);
  if (layout?.schema !== 2) return undefined;
  return indexes.get(layout)!.reverse.get(key(relative))?.store ?? (relative.split("/")[1]!.endsWith("-desktop") ? "desktop" : "live");
}
