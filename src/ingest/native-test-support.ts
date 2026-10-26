import { ParsePool } from "./parse-pool";
import { prepareCodexBytes, runNativeSync } from "./native-parse-sync";
import type { NewClaudeLimitHit } from "../db/schema";

export const prepareCodexFixture = (file: string, size: number) => runNativeSync("codex", { file, size });
export { prepareCodexBytes };
export async function parseClaudeFixture(store: string, file: string, since?: string, limitHits: NewClaudeLimitHit[] = []) {
  const pool = new ParsePool(1);
  try {
    const result = await pool.run("claude", { store, file, since });
    limitHits.push(...result.limitHits);
    return result.events;
  } finally { await pool.close(); }
}
