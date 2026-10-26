import type { SyncRequest } from "./coordinator";
interface RunnerInput { dbPath: string; rootDir: string; request: SyncRequest }
const input = JSON.parse(process.argv[2] ?? "") as RunnerInput;
const { SyncCoordinator } = await import("./coordinator");
const coordinator = new SyncCoordinator({ dbPath: input.dbPath, rootDir: input.rootDir });
const execution = coordinator.enter(input.request);
let result;
try { result = await execution.completion; } finally { coordinator.close(); }
console.log(`TOKENATLAS_SYNC_RESULT:${JSON.stringify(result)}`);
