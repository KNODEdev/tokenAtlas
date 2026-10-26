import { parentPort, workerData } from "node:worker_threads";
import { runScheduledArchiveCompression } from "../sync/archive-compression-schedule";
import type { ArchiveCompressionOptions } from "../sync/archive-compression";
import { initializeArchiveWriterIdentity } from "../sync/archive-writers";

const options = workerData as ArchiveCompressionOptions;
initializeArchiveWriterIdentity();
parentPort!.on("message", (message: { now: number } | { close: true }) => {
  if ("close" in message) { parentPort!.postMessage({ closed: true }); parentPort!.close(); return; }
  try { parentPort!.postMessage(runScheduledArchiveCompression(options, message.now)); }
  catch (cause) { parentPort!.postMessage({ nextWakeAt: message.now + 15 * 60_000, scanned: false,
    error: cause instanceof Error ? cause.message : String(cause) }); }
});
