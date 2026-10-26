import { relocateDatabase, validateDatabaseDestination } from "../db/relocate";
import { activeDatabasePath } from "../db";

export interface DatabaseRestartRequest { type: "relocate-database"; destination: string }

/** Keep the launcher alive while replacing the entire server process. */
export async function superviseServer(entrypoint: string, options: { envFile?: string; database?: string } = {}): Promise<number> {
  let database = options.database ?? activeDatabasePath(options.envFile);
  let result: { destination: string; error: string | null } | null = null;
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = () => { stopping = true; child?.kill(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      let requested: string | null = null;
      child = Bun.spawn([process.execPath, entrypoint, "--atlas-server-child"], {
        cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit",
        env: { ...process.env, TOKENATLAS_DB: database, TOKENATLAS_DB_RELOCATION_RESULT: JSON.stringify(result) },
        ipc(message: unknown) {
          const request = message as Partial<DatabaseRestartRequest>;
          if (request?.type === "relocate-database" && typeof request.destination === "string") requested = request.destination;
        },
      });
      const code = await child.exited;
      if (stopping || !requested) return code;
      try {
        if (code !== 75) throw new Error("The server could not stop cleanly; the original database remains active.");
        const destination = validateDatabaseDestination(database, requested);
        database = relocateDatabase(database, destination, options.envFile);
        result = { destination: database, error: null };
        console.log(`[tokenAtlas] Database moved to ${database}; restarting.`);
      } catch (error) {
        result = { destination: requested, error: error instanceof Error ? error.message : String(error) };
        console.error("[tokenAtlas] Database relocation failed; restarting the original database:", result.error);
      }
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
