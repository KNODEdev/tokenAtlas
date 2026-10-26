import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withArchiveWriter } from "../sync/archive-writers";

export const ARCHIVE_PATH_BINDING_FILE = path.join(".archive-inventory", "path-binding.json");

export interface CanonicalArchiveRoot {
  schema: 1;
  archiveId: string;
  originalLogicalRoot: string;
  currentPhysicalRoot: string;
}

export class ExternalArchivePathError extends Error {
  constructor(candidate: string, root: string) {
    super(`Path '${candidate}' is outside archive root '${root}'`);
    this.name = "ExternalArchivePathError";
  }
}

function validArchiveId(value: string): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid archive identity");
}

function normalized(value: string): string {
  return path.resolve(value);
}

function equalPath(left: string, right: string): boolean {
  const a = normalized(left);
  const b = normalized(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(normalized(root), normalized(candidate));
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative;
}

/** Bind the logical root once. Later physical-root changes never alter stored identities. */
export function bindCanonicalArchiveRoot(
  existing: CanonicalArchiveRoot | null,
  archiveId: string,
  observedPhysicalRoot: string,
): CanonicalArchiveRoot {
  validArchiveId(archiveId);
  const physical = normalized(observedPhysicalRoot);
  if (!existing) {
    return {
      schema: 1,
      archiveId,
      originalLogicalRoot: physical,
      currentPhysicalRoot: physical,
    };
  }
  if (existing.schema !== 1 || existing.archiveId !== archiveId) {
    throw new Error("Archive identity changed while rebasing its physical root");
  }
  validArchiveId(existing.archiveId);
  return {
    schema: 1,
    archiveId,
    originalLogicalRoot: normalized(existing.originalLogicalRoot),
    currentPhysicalRoot: physical,
  };
}

/** Convert a current physical archive path to its immutable logical identity. */
export function canonicalArchivePath(binding: CanonicalArchiveRoot, physicalPath: string): string {
  const relative = relativeInside(binding.currentPhysicalRoot, physicalPath);
  if (relative === null) throw new ExternalArchivePathError(physicalPath, binding.currentPhysicalRoot);
  return normalized(path.join(binding.originalLogicalRoot, relative));
}

/** Resolve an immutable logical archive path beneath the current physical root. */
export function physicalArchivePath(binding: CanonicalArchiveRoot, logicalPath: string): string {
  const relative = relativeInside(binding.originalLogicalRoot, logicalPath);
  if (relative === null) throw new ExternalArchivePathError(logicalPath, binding.originalLogicalRoot);
  return normalized(path.join(binding.currentPhysicalRoot, relative));
}

export function archiveRootsMatch(left: CanonicalArchiveRoot, right: CanonicalArchiveRoot): boolean {
  return left.archiveId === right.archiveId && equalPath(left.originalLogicalRoot, right.originalLogicalRoot);
}

interface StoredArchivePathBinding {
  schema: 1;
  archiveId: string;
  originalLogicalRoot: string;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readArchiveId(root: string): string | null {
  const file = path.join(root, ".archive-inventory", "identity.json");
  if (!fs.existsSync(file)) return null;
  const value = readJson(file) as { schema?: unknown; archiveId?: unknown };
  if (value.schema !== 1 || typeof value.archiveId !== "string") throw new Error("Invalid archive identity");
  validArchiveId(value.archiveId);
  return value.archiveId;
}

function storedBinding(value: unknown, archiveId: string): StoredArchivePathBinding {
  const binding = value as StoredArchivePathBinding;
  if (!binding || binding.schema !== 1 || binding.archiveId !== archiveId ||
      typeof binding.originalLogicalRoot !== "string" ||
      !path.isAbsolute(binding.originalLogicalRoot) || /[\r\n\0]/.test(binding.originalLogicalRoot)) {
    throw new Error("Invalid archive path binding");
  }
  validArchiveId(binding.archiveId);
  return { ...binding, originalLogicalRoot: normalized(binding.originalLogicalRoot) };
}

/** Metadata-only read. Missing metadata deliberately retains legacy root semantics. */
export function readCanonicalArchiveRoot(observedPhysicalRoot: string): CanonicalArchiveRoot | null {
  const physical = normalized(observedPhysicalRoot);
  const file = path.join(physical, ARCHIVE_PATH_BINDING_FILE);
  if (!fs.existsSync(file)) return null;
  const archiveId = readArchiveId(physical);
  if (!archiveId) throw new Error("Archive path binding exists without archive identity");
  const binding = storedBinding(readJson(file), archiveId);
  return {
    schema: 1,
    archiveId,
    originalLogicalRoot: binding.originalLogicalRoot,
    currentPhysicalRoot: physical,
  };
}

/** Explicit relocation-start operation. Ordinary readers never call this. */
export function pinCanonicalArchiveRoot(observedPhysicalRoot: string): CanonicalArchiveRoot {
  return withArchiveWriter(observedPhysicalRoot, () => pinCanonicalArchiveRootUnfenced(observedPhysicalRoot));
}
function pinCanonicalArchiveRootUnfenced(observedPhysicalRoot: string): CanonicalArchiveRoot {
  const physical = normalized(observedPhysicalRoot);
  if (!fs.existsSync(physical) || !fs.statSync(physical).isDirectory()) {
    throw new Error("Archive root is not a directory");
  }
  const archiveId = readArchiveId(physical);
  if (!archiveId) throw new Error("Archive identity must exist before pinning its logical root");
  const existing = readCanonicalArchiveRoot(physical);
  if (existing) return existing;

  const file = path.join(physical, ARCHIVE_PATH_BINDING_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const candidate = `${file}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(candidate, "wx");
    fs.writeFileSync(descriptor, JSON.stringify({
      schema: 1,
      archiveId,
      originalLogicalRoot: physical,
    } satisfies StoredArchivePathBinding));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try { fs.linkSync(candidate, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(candidate, { force: true });
  }
  const pinned = readCanonicalArchiveRoot(physical);
  if (!pinned) throw new Error("Archive path binding was not published");
  return pinned;
}
