import { parentPort } from "node:worker_threads";
import { initializeArchiveWriterIdentity } from "../sync/archive-writers";
import { syncClaudeCloudSessions } from "../sync/claude-cloud-sync";

initializeArchiveWriterIdentity();
parentPort!.on("message", async (message: { run: true } | { close: true }) => {
  if ("close" in message) { parentPort!.postMessage({ closed: true }); parentPort!.close(); return; }
  try { parentPort!.postMessage({ result: await syncClaudeCloudSessions() }); }
  catch (cause) { parentPort!.postMessage({ error: cause instanceof Error ? cause.message : String(cause) }); }
});
