import path from "node:path";
import { resolveDbPath } from "../db";
import { REPO_ROOT } from "../config/paths";
import { SyncCoordinator, enterSyncPipeline } from "./coordinator";
import { isVendorId, type SyncMode, type SyncScope, type SyncTrigger } from "./contracts";
import { initializeArchiveWriterIdentity } from "./archive-writers";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runSyncCli(args = process.argv.slice(2)): Promise<number> {
  const vendorValue = valueAfter(args, "--vendor");
  if (vendorValue && !isVendorId(vendorValue)) {
    console.error(`Unknown vendor '${vendorValue}'`);
    return 2;
  }
  const vendor = isVendorId(vendorValue) ? vendorValue : undefined;
  const modeValue = valueAfter(args, "--mode");
  const mode: SyncMode = args.includes("full") || modeValue === "full" ? "full" : "incremental";
  const triggerValue = valueAfter(args, "--trigger");
  const trigger: SyncTrigger =
    triggerValue === "manual" || triggerValue === "auto" || triggerValue === "cli"
      ? triggerValue
      : args.includes("auto")
        ? "auto"
        : "cli";
  const scope: SyncScope = vendor ? { kind: "vendor", vendor } : { kind: "all" };
  const dbPath = resolveDbPath(valueAfter(args, "--db"));
  const rootDir = path.resolve(valueAfter(args, "--root") ?? REPO_ROOT);
  const coordinator = new SyncCoordinator({ dbPath, rootDir });
  try {
    const execution = enterSyncPipeline(coordinator, { trigger, scope, mode });
    const result = await execution.completion;
    console.log(JSON.stringify(result, null, 2));
    return result.status === "success" ? 0 : 1;
  } finally {
    coordinator.close();
  }
}

if (import.meta.main) {
  initializeArchiveWriterIdentity();
  runSyncCli()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
