import path from "node:path";
import { resolveDbPath } from "../src/db";
import { initializeArchiveWriterIdentity } from "../src/sync/archive-writers";
import { activateArchiveRelocation } from "../src/sync/archive-relocation-activation";
import { startArchiveRelocation, advanceArchiveRelocation } from "../src/sync/archive-relocation-transfer";
import { readArchiveRelocation } from "../src/sync/archive-relocation-state";
import { verifyArchiveRelocation } from "../src/sync/archive-relocation-verification";
import { type ArchiveRelocationState } from "../src/sync/archive-relocation-contracts";
import { prepareArchiveCleanupPlan } from "../src/sync/archive-relocation-cleanup";

type Command = "start" | "advance" | "run" | "status" | "activate" | "verify" | "cleanup-plan";
interface Options { command: Command; stateDirectory: string; jobId?: string; from?: string; to?: string; after?:string }

export function relocationOptions(args: string[]): Options {
  const command = args[0];
  if (!command || !["start", "advance", "run", "status", "activate", "verify", "cleanup-plan"].includes(command)) {
    throw new Error("Expected start --from PATH --to PATH, or advance|run|status|activate|verify|cleanup-plan --job ID; optional --state-dir PATH; cleanup-plan accepts --after CHECKPOINT");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!["--from", "--to", "--job", "--state-dir", "--after"].includes(key) || values.has(key) || !value?.trim() || value.startsWith("--")) {
      throw new Error(`Invalid or duplicate relocation option: ${key}`);
    }
    values.set(key, value);
  }
  if(values.has("--after")&&command!=="cleanup-plan")throw new Error("--after is only valid for cleanup-plan");
  if (command === "start") {
    if (!values.has("--from") || !values.has("--to") || values.has("--job")) throw new Error("start requires --from and --to and creates a new job ID");
  } else if (!values.has("--job") || values.has("--from") || values.has("--to")) {
    throw new Error(`${command} requires --job; source and destination come from its durable state`);
  }
  return { command: command as Command, stateDirectory: path.resolve(values.get("--state-dir") ?? path.join(path.dirname(resolveDbPath()), "archive-relocations")),
    jobId: values.get("--job"), from: values.get("--from"), to: values.get("--to"), after:values.get("--after") };
}

export function relocationProgress(state: ArchiveRelocationState) {
  return { jobId: state.jobId, archiveId: state.archiveId, phase: state.phase,
    source: state.sourceRoot, destination: state.destinationRoot,
    files: state.entries.length,
    copiedFiles: state.entries.filter(entry => entry.status === "copied" || entry.status === "verified").length,
    verifiedFiles: state.entries.filter(entry => entry.status === "verified").length,
    bytes: state.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    updatedAt: state.updatedAt, lastError: state.lastError ?? null,
    switched: state.phase === "activated",
    activation: state.activation ?? null,
    postActivation: state.postActivation ?? null,
    readWriteVerified: state.postActivation?.status === "verified",
  };
}

export async function runArchiveRelocationCli(args: string[], print: (line: string) => void = console.log): Promise<void> {
  const options = relocationOptions(args);
  if (options.command === "start") {
    const state = startArchiveRelocation(options.from!, options.to!, options);
    print(JSON.stringify(relocationProgress(state)));
    return;
  }
  if (options.command === "status") {
    print(JSON.stringify(relocationProgress(readArchiveRelocation(options.stateDirectory, options.jobId!))));
    return;
  }
  if (options.command === "activate") {
    const state=await activateArchiveRelocation(options.jobId!,{
      stateDirectory:options.stateDirectory,database:resolveDbPath(),env:process.env,
    });
    print(JSON.stringify(relocationProgress(state)));
    return;
  }
  if(options.command==="verify") {
    print(JSON.stringify(relocationProgress(await verifyArchiveRelocation(options.jobId!,{stateDirectory:options.stateDirectory,env:process.env}))));
    return;
  }
  if(options.command==="cleanup-plan") {
    print(JSON.stringify(await prepareArchiveCleanupPlan(options.jobId!,{stateDirectory:options.stateDirectory,after:options.after,env:process.env})));
    return;
  }
  do {
    const state = await advanceArchiveRelocation(options.jobId!, options);
    print(JSON.stringify(relocationProgress(state)));
    if (state.phase === "ready-to-switch" || state.phase === "activated" || options.command === "advance") return;
  } while (true);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (relocationOptions(args).command !== "status") initializeArchiveWriterIdentity();
    await runArchiveRelocationCli(args);
  }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
