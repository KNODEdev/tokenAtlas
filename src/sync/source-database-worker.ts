import path from "node:path";
import { mergeSourceDatabase, snapshotSourceDatabase, SourceDatabaseConflict, type SourceDatabaseVendor } from "./source-database-merge";

// The parent launches a fresh process with its workspace environment before SQLite initializes.
const input = JSON.parse(process.argv[2]!) as {source:string;snapshot:string;archive:string|null;output:string;vendor:SourceDatabaseVendor;temporaryDirectory:string};
const temporaryEnvironment = Object.fromEntries(["TMP","TEMP","TMPDIR","SQLITE_TMPDIR"].map(name=>[name,process.env[name]]));
try {
  if (Object.values(temporaryEnvironment).some(value=>value!==input.temporaryDirectory)
    || path.dirname(input.snapshot)!==input.temporaryDirectory || path.dirname(input.output)!==input.temporaryDirectory) throw new Error("SQLite worker temporary environment mismatch");
  snapshotSourceDatabase(input.source,input.snapshot,input.vendor);
  const merge=mergeSourceDatabase(input);
  console.log(JSON.stringify({merge,temporaryEnvironment}));
} catch (error) {
  console.log(JSON.stringify({error:{message:error instanceof Error?error.message:String(error),...(error instanceof SourceDatabaseConflict?{reason:error.reason,table:error.table}:{})},temporaryEnvironment}));
  process.exitCode=1;
}
