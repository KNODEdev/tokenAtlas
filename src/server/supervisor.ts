import path from "node:path";
import { relocateDatabase, validateDatabaseDestination } from "../db/relocate";
import { activeDatabasePath } from "../db";
import { prepareLocalSettings } from "../config/local-settings";

export interface DatabaseRestartRequest { type: "relocate-database"; destination: string }
export interface ArchiveSwitchRequest { type: "activate-archive"; jobId: string; stateDirectory: string }
type RestartRequest = DatabaseRestartRequest | ArchiveSwitchRequest;

function restartRequest(message: unknown): RestartRequest | null {
  const request = (message ?? {}) as { type?: unknown; destination?: unknown; jobId?: unknown; stateDirectory?: unknown };
  if (request.type === "relocate-database" && typeof request.destination === "string")
    return { type: "relocate-database", destination: request.destination };
  if (request.type === "activate-archive" && typeof request.jobId === "string" && typeof request.stateDirectory === "string")
    return { type: "activate-archive", jobId: request.jobId, stateDirectory: request.stateDirectory };
  return null;
}

/** The fenced archive switch runs while no server process holds writers or the database. */
export async function activateArchiveSwitch(request: ArchiveSwitchRequest, database: string,
  env: Record<string, string | undefined> = process.env): Promise<{ jobId: string; destination: string; error: string | null }> {
  const worker = path.join(import.meta.dir, "..", "sync", "archive-relocation-activation-worker.ts");
  // An empty override (e.g. `TOKENATLAS_ARCHIVE=` in .env) means unset everywhere else; the switch would reject it.
  const clean = Object.fromEntries(Object.entries(env).filter(([key, value]) => !(key.startsWith("TOKENATLAS_") && value !== undefined && !value.trim())));
  const proc = Bun.spawn([process.execPath, worker, request.jobId, request.stateDirectory, database],
    { cwd: process.cwd(), env: clean, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const { readArchiveRelocation } = await import("../sync/archive-relocation");
  let destination = "";
  try { destination = readArchiveRelocation(request.stateDirectory, request.jobId).destinationRoot; } catch { /* reported below */ }
  if (code === 0 && /"phase":"activated"/.test(stdout)) return { jobId: request.jobId, destination, error: null };
  // Bun prints the thrown message as "error: …" above its stack and version banner.
  const reason = stderr.match(/^(?:\w*Error|error):\s*(.+)$/m)?.[1]?.trim();
  return { jobId: request.jobId, destination, error: reason || `Archive switch stopped (${code}).` };
}

/** Keep the launcher alive while replacing the entire server process. */
export async function superviseServer(entrypoint: string, options: { envFile?: string; database?: string } = {}): Promise<number> {
  prepareLocalSettings(options.envFile);
  let database = options.database ?? activeDatabasePath(options.envFile);
  let result: { destination: string; error: string | null } | null = null;
  let archiveResult: { jobId: string; destination: string; error: string | null } | null = null;
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = () => { stopping = true; child?.kill(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      let requested: RestartRequest | null = null;
      child = Bun.spawn([process.execPath, entrypoint, "--atlas-server-child"], {
        cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit",
        env: { ...process.env, TOKENATLAS_DB: database, TOKENATLAS_DB_RELOCATION_RESULT: JSON.stringify(result),
          TOKENATLAS_ARCHIVE_MOVE_RESULT: JSON.stringify(archiveResult) },
        ipc(message: unknown) { requested = restartRequest(message) ?? requested; },
      });
      const code: number = await child.exited;
      const request = requested as RestartRequest | null;
      if (stopping || !request) return code;
      if (request.type === "activate-archive") {
        archiveResult = code === 75 ? await activateArchiveSwitch(request, database)
          : { jobId: request.jobId, destination: "", error: "The server could not stop cleanly; the archive was not switched." };
        if (archiveResult.error) console.error("[tokenAtlas] Archive switch failed; restarting with the current archive:", archiveResult.error);
        else console.log(`[tokenAtlas] Archive moved to ${archiveResult.destination}; restarting.`);
        continue;
      }
      try {
        if (code !== 75) throw new Error("The server could not stop cleanly; the original database remains active.");
        const destination = validateDatabaseDestination(database, request.destination);
        database = relocateDatabase(database, destination, options.envFile);
        result = { destination: database, error: null };
        console.log(`[tokenAtlas] Database moved to ${database}; restarting.`);
      } catch (error) {
        result = { destination: request.destination, error: error instanceof Error ? error.message : String(error) };
        console.error("[tokenAtlas] Database relocation failed; restarting the original database:", result.error);
      }
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
