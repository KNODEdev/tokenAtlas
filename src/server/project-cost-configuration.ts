import type { RateCard } from "./pricing";
import { ratesWithoutAuthoritativeCodexPolicy } from "./codex-ledger-report-dependencies";
import { loadRateCard } from "./rate-cards-file";
import path from "node:path";
import { REPO_ROOT } from "../config/paths";
import { loadClaudeGauge } from "./claude-limit";
import { loadGrokGauge } from "./grok-limit";

/**
 * The declared capacity inputs that do not live in a tracked source table: the manual gauges
 * and the z.ai price list. Editing any of them must re-measure the report; nothing here
 * changes on its own, which is why the report key needs no clock beside it.
 */
export function projectCapacityConfiguration(): unknown {
  let glmRates: RateCard | null = null;
  try { glmRates = ratesWithoutAuthoritativeCodexPolicy(loadRateCard(path.join(REPO_ROOT, "rate-cards.json"))); } catch {}
  return [loadClaudeGauge(), loadGrokGauge(), glmRates];
}
