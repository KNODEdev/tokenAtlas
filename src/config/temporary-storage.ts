import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveLocalStateRootBase, assertLocalStateOutsideRoots } from "./archive-locator";
import { resolveArchiveRootFromEnv, resolveConfigRootFromEnvironment } from "./path-environment";

type Environment = Record<string, string | undefined>;
const SELECTION_FILE = "temporary-storage.json";

function physical(value: string): string {
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(physical(parent), path.basename(resolved));
}
function contains(root: string, candidate: string): boolean {
  const relative = path.relative(physical(root), physical(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function selectionFile(env: Environment): string {
  const root = resolveLocalStateRootBase(env);
  assertLocalStateOutsideRoots(root, [resolveArchiveRootFromEnv(env), resolveConfigRootFromEnvironment(env)]);
  return path.join(root, SELECTION_FILE);
}

/** Scratch must never contain durable facts, recovery work or archive evidence. */
export function validateTemporaryDirectory(input: string, database: string, env: Environment = process.env): string {
  if (typeof input !== "string" || !input.trim() || /[\r\n\0]/.test(input)) throw new Error("Podaj pełną ścieżkę lokalnego folderu tymczasowego.");
  const expanded = input.trim().startsWith("~") ? path.join(env.USERPROFILE || os.homedir(), input.trim().slice(1)) : input.trim();
  if (!path.isAbsolute(expanded) || /^[/\\]{2}/.test(expanded)) throw new Error("Folder tymczasowy wymaga pełnej lokalnej ścieżki.");
  const root = physical(expanded);
  const localState = resolveLocalStateRootBase(env);
  const shared = [resolveArchiveRootFromEnv(env), resolveConfigRootFromEnvironment(env),
    env.OneDrive, env.ONEDRIVE, env.OneDriveCommercial, env.OneDriveConsumer].filter((value): value is string => !!value?.trim());
  const durable = [database, `${database}-wal`, `${database}-shm`, selectionFile(env),
    path.join(path.dirname(database), "sync-staging"),
    path.join(path.dirname(database), "archive-relocations"),
    path.join(path.dirname(database), "archive-layout"),
    env.TOKENATLAS_SNAPSHOT_DIR || path.join(path.dirname(database), "atlas-index-snapshots")];
  if (/^[/\\]{2}/.test(root) || /(^|[/\\])onedrive(?:\s*-\s*[^/\\]+)?([/\\]|$)/i.test(root)
      || shared.some(value => contains(value, root) || contains(root, value))
      || (contains(localState, root) && !contains(path.join(localState, "temp"), root))
      || durable.some(value => contains(root, value))
      || durable.slice(4).some(value => contains(value, root))) {
    throw new Error("Folder tymczasowy musi być oddzielony od archiwum, bazy, kopii zapasowych i trwałego stanu pracy.");
  }
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) throw new Error("Ścieżka tymczasowa nie jest folderem.");
  return root;
}

export function temporaryDirectory(database: string, env: Environment = process.env): string {
  const file = selectionFile(env);
  let selected: string | undefined;
  if (fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.schema !== 1 || typeof value.root !== "string") throw new Error("Nieprawidłowe lokalne ustawienie folderu tymczasowego.");
    selected = value.root;
  }
  return validateTemporaryDirectory(selected || env.TOKENATLAS_TEMP_DIR || path.join(resolveLocalStateRootBase(env), "temp"), database, env);
}

/** The selection is machine-local; existing jobs retain their own workspace. */
export function saveTemporaryDirectory(input: string, database: string, env: Environment = process.env): string {
  const root = validateTemporaryDirectory(input, database, env);
  const file = selectionFile(env);
  fs.mkdirSync(root, { recursive: true });
  const probe = path.join(root, `.write-check-${randomUUID()}`);
  const fd = fs.openSync(probe, "wx");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); fs.unlinkSync(probe); }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const candidate = `${file}.${randomUUID()}.tmp`;
  try {
    const out = fs.openSync(candidate, "wx", 0o600);
    try { fs.writeFileSync(out, JSON.stringify({ schema: 1, root }) + "\n"); fs.fsyncSync(out); }
    finally { fs.closeSync(out); }
    fs.renameSync(candidate, file);
  } finally { fs.rmSync(candidate, { force: true }); }
  return root;
}

export function createTemporaryWorkspace(prefix: string, database: string, env: Environment = process.env) {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new Error("Invalid workspace prefix");
  const root = temporaryDirectory(database, env);
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, `${prefix}-`));
  return { directory, dispose: () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
