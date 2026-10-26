import path from "node:path";
import { fingerprint } from "./file-fingerprint";
import { parseWorkerCount } from "../ingest/parse-pool";

/** One file's content identity, or the message its verification failed with. */
export type FingerprintResult = { fingerprint: string } | { error: string };

// Below this many files a worker process costs more than it saves.
const PARALLEL_FROM = 64;

function inline(file: string): FingerprintResult {
  try { return { fingerprint: fingerprint(file) }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

/**
 * Content identities of many files, in input order. Callers are synchronous (the queue
 * runs inside the coordinator's `enter()`), so a large batch is hashed by a child
 * process that spreads the files over fingerprint workers; any failure of that process
 * falls back to hashing here, one file at a time.
 */
export function fingerprintAll(files: string[],workers=parseWorkerCount()): FingerprintResult[] {
  if (files.length < PARALLEL_FROM || workers < 2) return files.map(inline);
  try {
    const child = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "fingerprint-batch.ts")], {
      stdin: Buffer.from(JSON.stringify(files)), stdout: "pipe", stderr: "pipe", env: {...process.env,TOKENATLAS_PARSE_WORKERS:String(workers)},
    });
    if (child.exitCode === 0) {
      const results = JSON.parse(child.stdout.toString()) as FingerprintResult[];
      if (Array.isArray(results) && results.length === files.length) return results;
    }
  } catch { /* hashed below */ }
  return files.map(inline);
}

async function hashInWorkers(files: string[]): Promise<FingerprintResult[]> {
  // Hashing needs neither the native parser process nor its general-purpose worker imports.
  // Workers pull one file at a time, preserving load balancing for uneven transcript sizes.
  const results = new Array<FingerprintResult>(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parseWorkerCount(), files.length) }, async () => {
    let worker: Worker;
    try { worker = new Worker(new URL("./fingerprint-worker.ts", import.meta.url).href); }
    catch { return; }
    try {
      while (next < files.length) {
        const index = next++;
        try {
          results[index] = await new Promise<FingerprintResult>((resolve, reject) => {
            const cleanup = () => worker.removeEventListener("close", closed);
            function closed() { reject(new Error("Fingerprint worker exited")); }
            worker.onmessage = event => { cleanup(); resolve(event.data as FingerprintResult); };
            worker.onerror = event => { cleanup(); event.preventDefault(); reject(new Error(event.message)); };
            worker.addEventListener("close", closed, { once: true });
            worker.postMessage(files[index]);
          });
        } catch {
          results[index] = inline(files[index]!);
          break;
        }
      }
    } finally { await worker.terminate(); }
  }));
  // A worker that could not start or exited cannot leave any selected source unverified.
  return files.map((file, index) => results[index] ?? inline(file));
}

if (import.meta.main) {
  const files = JSON.parse(await Bun.stdin.text()) as string[];
  process.stdout.write(JSON.stringify(await hashInWorkers(files)));
}
