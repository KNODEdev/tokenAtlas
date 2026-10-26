import { Database } from "./sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ARCHIVE_ROOT } from "../config/paths";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { databaseEnvironmentContents, databaseEnvFile } from "./location";
import { temporaryDirectory, createTemporaryWorkspace } from "../config/temporary-storage";

function physicalPath(value: string): string {
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(physicalPath(parent), path.basename(resolved));
}
const key = (value: string) => physicalPath(value).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");

export function validateDatabaseDestination(source: string, input: string, env = process.env): string {
  if (typeof input !== "string" || !input.trim() || /[\r\n\0]/.test(input)) throw new Error("Choose a local database file. / Wybierz lokalny plik bazy.");
  const expanded = input.trim().startsWith("~") ? path.join(os.homedir(), input.trim().slice(1)) : input.trim();
  if (!path.isAbsolute(expanded) || /^[/\\]{2}/.test(expanded)) throw new Error("The database needs an absolute local path. / Baza wymaga pełnej lokalnej ścieżki.");
  const destination = physicalPath(expanded);
  temporaryDirectory(destination, env);
  const candidate = key(destination);
  const forbidden = [ARCHIVE_ROOT, env.TOKENATLAS_ARCHIVE, env.OneDrive, env.ONEDRIVE, env.OneDriveCommercial, env.OneDriveConsumer]
    .filter((p): p is string => !!p?.trim());
  if (/^[/\\]{2}/.test(destination) || /(^|\/)onedrive(?:\s*-\s*[^/]+)?(\/|$)/i.test(candidate)
    || forbidden.some(root => candidate === key(root) || candidate.startsWith(key(root) + "/"))) {
    throw new Error("Keep the database outside OneDrive and the archive. / Baza musi być poza OneDrive i archiwum.");
  }
  if (candidate === key(source)) throw new Error("This is already the active database. / To jest już aktywna baza.");
  if ([destination, destination + "-wal", destination + "-shm"].some(p => fs.existsSync(p))) throw new Error("The destination already exists. / Plik docelowy już istnieje.");
  return destination;
}

/** Called by the supervisor only after the old server and its workers have stopped. */
export function relocateDatabase(source: string, requested: string, envFile = databaseEnvFile, env = process.env): string {
  if (process.env.NODE_ENV === "test" && path.resolve(envFile) === databaseEnvFile) throw new Error("Tests must supply a fixture envFile.");
  const destination = validateDatabaseDestination(source, requested, env);
  const previousEnv = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const admission = new Database(source, { readwrite: true });
  let workspace: ReturnType<typeof createTemporaryWorkspace> | undefined;
  let reader: Database | undefined;
  let published = false;
  try {
    admission.exec("BEGIN IMMEDIATE;");
    // Refuse another process's unfinished import rather than copying its partial publication.
    if (admission.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_runs'").get()
      && admission.query("SELECT 1 FROM sync_runs WHERE status='running' LIMIT 1").get()) throw new Error("Synchronization is running; try again after it finishes.");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    workspace = createTemporaryWorkspace("database-relocation", source, env);
    const temporary = path.join(workspace.directory, "database.sqlite");
    reader = new Database(source, { readonly: true });
    reader.query("VACUUM INTO ?").run(temporary);
    const copied = new Database(temporary, { readonly: true });
    try {
      const checks = copied.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      if (checks.length !== 1 || checks[0]?.integrity_check !== "ok") throw new Error("The copied database failed integrity verification.");
    } finally { copied.close(); }
    const fd = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Exclusive publication never overwrites a file that appeared after validation.
    fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
    published = true;
    const destinationFd = fs.openSync(destination, "r+");
    try { fs.fsyncSync(destinationFd); } finally { fs.closeSync(destinationFd); }
    atomicArchiveWrite(envFile, databaseEnvironmentContents(previousEnv, destination));
    return destination;
  } catch (error) {
    if (published) fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    reader?.close();
    if (admission.inTransaction) admission.exec("ROLLBACK");
    admission.close();
    workspace?.dispose();
  }
}
