import type { Database } from "bun:sqlite";
import { codexLedgerBacklog } from "../db/codex-ledger-producer";
import { usageLedgerProviderIds } from "./subscription-accounting-adapters";
import { BacklogProgress, ProgressRegistry } from "../sync/progress";
import { accountPeriodBacklog } from "./account-period-feed";
import { limitWindowBacklog } from "./limit-window-producer";
import { usageLedgerBacklog } from "./usage-ledger-producer";
import { windowUsageProgress } from "./window-usage-producer";

const FILL_PHASES = {
  copies: { label: "registering source files", unit: "files" },
  events: { label: "valuing calls", unit: "files" },
  canonical: { label: "resolving copies", unit: "records" },
  gaps: { label: "measuring active time", unit: "files" },
} as const;

const LEDGER_PHASES = {
  backfill: { label: "building history", unit: "records" },
  resolve: { label: "resolving accounts", unit: "records" },
  revalue: { label: "revaluing", unit: "changes" },
  reconcile: { label: "applying changes", unit: "days" },
  activity: { label: "measuring active time", unit: "items" },
} as const;

/**
 * The background producers after an import report their queues to the progress register:
 * the usage ledger of each provider, the Codex ledger (a fill from empty by its phases, else
 * changed source files, then sums and rule work), the account-period feed, the limit-window
 * registers and the window sums. Each reading is a few indexed counts; an empty queue ends its entry.
 */
export function reportBackgroundProgress(db: Database, registry: ProgressRegistry, backlog: BacklogProgress): void {
  for (const provider of usageLedgerProviderIds()) {
    const scope = `usage-ledger:${provider}`;
    const ledger = usageLedgerBacklog(db, provider);
    if (!ledger) { registry.end(scope); continue; }
    const phase = LEDGER_PHASES[ledger.phase];
    if (ledger.pending === null) registry.report(scope, ledger.phase, phase.label, phase.unit, 0, null);
    else backlog.report(scope, ledger.phase, phase.label, phase.unit, ledger.pending);
  }
  const codex = codexLedgerBacklog(db);
  if (codex?.fill) {
    const phase = FILL_PHASES[codex.fill.phase];
    registry.report("codex-ledger", `fill.${codex.fill.phase}`, phase.label, phase.unit, codex.fill.done, codex.fill.total);
  } else if (codex?.files) backlog.report("codex-ledger", "copies", "valuing source files", "files", codex.files);
  else backlog.report("codex-ledger", "aggregates", "updating sums", "items", codex?.aggregates ?? 0);
  backlog.report("account-periods", "feed", "reading limit readings", "readings", accountPeriodBacklog(db) ?? 0);
  backlog.report("limit-windows", "windows", "dividing limit windows", "accounts", limitWindowBacklog(db) ?? 0);
  const sums = windowUsageProgress(db);
  if (sums.done < sums.total) registry.report("window-usage", "sums", "summing limit windows", "items", sums.done, sums.total);
  else registry.end("window-usage");
}
