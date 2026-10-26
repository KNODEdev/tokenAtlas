import fs from "node:fs";
import path from "node:path";
import { activeDatabasePath } from "../../src/db";
import { atlasIndexSnapshotPool } from "../../src/config/paths";
import { STARTUP_PHASES, type StartupStatus, type StartupUpdate } from "../../src/shared/startup";

interface PreparationCommand { phase: "migration-check" | "configuration"; cmd: string[] }

/** Serve the real application bundle while database preparation runs in a separate process. */
export function startPreparation(options: {
  port: number; dbPath?: string; publicDirectory?: string; commands?: PreparationCommand[];
}) {
  const dbPath = options.dbPath ?? activeDatabasePath();
  const publicDirectory = path.resolve(options.publicDirectory ?? path.join(import.meta.dir, "../../public"));
  const startedAt = new Date().toISOString();
  const state: StartupStatus = { phase: "migration-check", startedAt, stageStartedAt: startedAt,
    snapshotDirectory: atlasIndexSnapshotPool(dbPath), snapshotBytes: null, snapshotTotalBytes: null,
    snapshotMigrations: null, error: null };
  let snapshotFile: string | undefined;
  let copiedBytes: number | null = null;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let closed = false;
  const update = (next: StartupUpdate) => {
    if (state.phase !== next.phase) state.stageStartedAt = new Date().toISOString();
    state.phase = next.phase;
    if (next.snapshotFile) snapshotFile = next.snapshotFile;
    if (next.snapshotTotalBytes != null) state.snapshotTotalBytes = next.snapshotTotalBytes;
    if (next.snapshotMigrations) state.snapshotMigrations = next.snapshotMigrations;
  };
  const status = (): StartupStatus => {
    if (snapshotFile) {
      try { copiedBytes = fs.statSync(snapshotFile).size; } catch { /* A published file has just changed names. */ }
    }
    return { ...state, snapshotBytes: copiedBytes };
  };
  const server = Bun.serve({ port: options.port, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Cache-Control": "no-store" };
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    if (url.pathname === "/api/startup") return Response.json(status(), { headers });
    if (url.pathname.startsWith("/api/"))
      return Response.json({ error: "Application startup is preparing the database" }, { status: 503, headers });
    let relative: string;
    try { relative = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
    const target = path.resolve(publicDirectory, relative === "/" ? "index.html" : `.${relative}`);
    const within = path.relative(publicDirectory, target);
    if (within.startsWith("..") || path.isAbsolute(within)) return new Response(null, { status: 404 });
    const file = Bun.file(target);
    if (!await file.exists()) return new Response(null, { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, { headers: { ...headers, "Content-Type": file.type } });
  } });
  const close = () => {
    if (closed) return;
    closed = true;
    child?.kill();
    server.stop(true);
  };
  const commands = options.commands ?? [
    { phase: "migration-check", cmd: [process.execPath, path.join(import.meta.dir, "../../src/db/migrate.ts"), "--db", dbPath] },
    { phase: "configuration", cmd: [process.execPath, path.join(import.meta.dir, "../../src/doctor.ts")] },
  ];
  const done = (async (): Promise<number> => {
    try {
      for (const command of commands) {
        if (closed) return 1;
        update({ phase: command.phase });
        let diagnostic = "";
        const launched = Bun.spawn(command.cmd, { stdin: "inherit", stdout: "pipe", stderr: "pipe",
          env: { ...process.env, TOKENATLAS_DB: dbPath } });
        child = launched;
        const stdout = (async () => {
          const decoder = new TextDecoder();
          let pending = "";
          for await (const chunk of launched.stdout) {
            process.stdout.write(chunk);
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop()!;
            for (const line of lines) {
              if (!line.startsWith("[tokenAtlas startup] ")) continue;
              try {
                const next = JSON.parse(line.slice("[tokenAtlas startup] ".length)) as Partial<StartupUpdate>;
                if (STARTUP_PHASES.includes(next.phase!)
                  && (next.snapshotFile === undefined || typeof next.snapshotFile === "string")
                  && (next.snapshotTotalBytes === undefined || (Number.isFinite(next.snapshotTotalBytes) && next.snapshotTotalBytes > 0))
                  && (next.snapshotMigrations === undefined
                    || (Array.isArray(next.snapshotMigrations) && next.snapshotMigrations.every((tag) => typeof tag === "string"))))
                  update(next as StartupUpdate);
              } catch { /* Ordinary output cannot advance a startup stage. */ }
            }
          }
        })();
        const stderr = (async () => {
          for await (const chunk of launched.stderr) {
            const text = new TextDecoder().decode(chunk);
            process.stderr.write(text);
            diagnostic = (diagnostic + text).slice(-8_000);
          }
        })();
        const code = await child.exited;
        await Promise.all([stdout, stderr]);
        child = undefined;
        if (closed) return 1;
        if (code !== 0) throw new Error(diagnostic.trim() || `${command.phase} exited with code ${code}`);
      }
      update({ phase: "server" });
      // The launcher starts the normal server on this same port; the page keeps polling through the handoff.
      close();
      return 0;
    } catch (error) {
      update({ phase: "failed" });
      state.error = error instanceof Error ? error.message : String(error);
      console.error("[tokenAtlas startup] Preparation failed:", state.error);
      // Leave the listener alive so the failure remains visible in the application.
      return 1;
    }
  })();
  return { server, done, close, status };
}

if (import.meta.main) {
  const preparation = startPreparation({ port: Number(process.env.PORT || 7331) });
  const stop = () => { preparation.close(); process.exit(1); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const code = await preparation.done;
  if (code === 0) {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  process.exitCode = code;
}
