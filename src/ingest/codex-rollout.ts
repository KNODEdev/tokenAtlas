import fs from "node:fs";
import { fileStamp } from "../sync/jsonl-inspection";
import { compressedRollout, rolloutIdentity } from "../shared/codex-rollout-path";
import { prefixMatches, withDecodedArchiveFiles as withDecodedRollouts } from "./archive-codec";
export { compressedRollout, isCodexRollout, rolloutIdentity } from "../shared/codex-rollout-path";
export { prefixMatches, withDecodedArchiveFiles as withDecodedRollouts, withArchiveDecodeCache as withRolloutDecodeCache } from "./archive-codec";
export function rolloutRepresentations(file: string): string[] {
  const plain = rolloutIdentity(file);
  return [plain, `${plain}.zst`].filter(candidate => fileStamp(candidate) !== null);
}

/** Cloud clients can temporarily deliver both names. Accept one only when their histories agree. */
export function selectRolloutRepresentation(file: string): string {
  const plain = rolloutIdentity(file), compressed = `${plain}.zst`;
  // The ordinary JSONL path keeps its existing stat/parse budget. Its caller checks regularity.
  if (!fs.existsSync(compressed)) return plain;
  if (!fs.existsSync(plain)) return compressed;
  const files = [plain, compressed];
  return withDecodedRollouts(files, decoded => {
    const sizes = decoded.map(candidate => fs.statSync(candidate).size);
    if (!prefixMatches(decoded[0]!, decoded[1]!, Math.min(...sizes)))
      throw new Error(`Conflicting Codex rollout representations: ${rolloutIdentity(file)}`);
    return files[sizes[0]! >= sizes[1]! ? 0 : 1]!;
  });
}
