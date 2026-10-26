import { randomUUID } from "node:crypto";
import type { ArchiveRelocationProcessProof } from "./archive-relocation-contracts";
import { UUID, MACHINE_UUID } from "./archive-relocation-contracts";
import fs from "node:fs";
import { ensureRootStillMatches } from "./archive-relocation-paths";
import { readLocalMachineId } from "../config/local-identity";

export const PROCESS_INSTANCE = randomUUID();

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function validProcessProof(value:ArchiveRelocationProcessProof):boolean {
  return !!value&&UUID.test(value.processInstance)&&Number.isSafeInteger(value.pid)&&value.pid>0
    &&Number.isFinite(Date.parse(value.processStartedAt))&&MACHINE_UUID.test(value.machineId)
    &&typeof value.destinationStamp==="string"&&/^\d+:\d+:\d+$/.test(value.destinationStamp);
}

export function destinationStamp(root:string):string {
  ensureRootStillMatches(root);
  const stat=fs.statSync(root,{bigint:true});
  // Unlike directory mtime, these do not change when normal archive writers add files.
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

export function currentProcessProof(root:string):ArchiveRelocationProcessProof {
  const machineId=readLocalMachineId();
  if(!machineId)throw new Error("Archive verification requires initialized local writer identity");
  return {processInstance:PROCESS_INSTANCE,pid:process.pid,processStartedAt:PROCESS_STARTED_AT,machineId,destinationStamp:destinationStamp(root)};
}
