import type { Database } from "../db/sqlite";
import { factTableRevision } from "../db/fact-day-revisions";
import type { ActivityIssueReason, ActivityProviderId, ActivityStage, ActivityState, ActivityView, AppActivity } from "../shared/app-activity";
import { progressDirectory, readProgress } from "../sync/progress";
import type { ReportActivity } from "./data-read";
import { codexLedgerWorkPending, readCodexLedgerState } from "../db/codex-ledger-state";
import { accountPeriodFeedBehind } from "./account-period-feed";

const providers: ActivityProviderId[] = ["codex", "claude", "gemini", "grok", "glm"];
const REPORT_LIMIT = 256;
const sourceFor: Record<ActivityProviderId, string> = { codex: "events", claude: "claude_events", gemini: "gemini_events", grok: "grok_events", glm: "oc_events" };
const observers = new WeakMap<Database, { started: number; checkpoints: Map<string, { signature: string; changed: number | null }> }>();
type Scope = { scope: string; version: number; cursor: number; phase: string; status: string; bookmark: string | number };
const emptyStage = (state: ActivityState): ActivityStage => ({ state, version: null, checkpoint: null, cursor: null, lastProgressAt: null, etaMs: null });

function viewFor(pathname: string): ActivityView {
  if (pathname === "/api/roster") return "subscriptions";
  if (pathname === "/api/accounts") return "accounts";
  if (/^\/api\/(project|projects)/.test(pathname)) return "projects";
  if (/^\/api\/(history|repo-history)/.test(pathname)) return "history";
  if (/^\/api\/(plan-|capacity|codex-accounting|subscription-accounting)/.test(pathname)) return "capacity";
  if (/^\/api\/(usage|global-usage)/.test(pathname)) return "usage";
  if (["/api/windows", "/api/overview", "/api/health"].includes(pathname)) return "overview";
  return "other";
}

/** Bounded metadata only. Never invokes readiness, maintenance, source reads or cache preparation. */
export function readAppActivity(db: Database, now = Date.now(), reports: readonly ReportActivity[] = []): AppActivity {
  let observer = observers.get(db);
  if (!observer) { observer = { started: now, checkpoints: new Map() }; observers.set(db, observer); }
  const result: AppActivity = { observedAt: now, observationStartedAt: observer.started, busy: false, unavailable: false,
    providers: [], reports: { pending: 0, failed: 0, truncated: false, views: [] },
    progress: readProgress(progressDirectory(db.filename)) };
  let periodsPending = false;
  const exists = (table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const observe = (key: string, row: Scope, state: ActivityState, extra: unknown = null): ActivityStage => {
    // Opaque identities may contain source details: retain only in process, never in the response.
    const signature = JSON.stringify([row.scope, row.version, row.cursor, row.bookmark, row.phase, row.status, extra]);
    const previous = observer.checkpoints.get(key);
    const changed = previous && previous.signature !== signature ? Math.max(now, previous.changed ?? observer.started) : previous?.changed ?? null;
    observer.checkpoints.set(key, { signature, changed });
    const numeric = typeof row.bookmark === "number" ? row.bookmark : /^\d+$/.test(row.bookmark) ? Number(row.bookmark) : null;
    return { state, version: row.version, checkpoint: numeric !== null && Number.isSafeInteger(numeric) ? numeric : null,
      cursor: row.cursor, lastProgressAt: changed, etaMs: null };
  };
  try {
    const ledgers = exists("usage_ledger_state");
    for (const provider of providers) {
      let register = emptyStage("missing");
      // Codex is valued by its own price ledger, not the shared usage ledger.
      const codexLedger = provider === "codex" && ledgers ? readCodexLedgerState(db) : null;
      if (codexLedger) {
        // Changed files and rule scopes queued (one key lookup); their counters are in the progress register.
        const working = codexLedgerWorkPending(db, ["copy", "blocked", "rules"]);
        const state: ActivityState = codexLedger.status === "ready" && !working ? "ready" : "backfill";
        register = observe("codex:ledger", { scope: "codex-ledger", version: codexLedger.version, cursor: codexLedger.covered, phase: codexLedger.phase,
          status: codexLedger.status, bookmark: codexLedger.revision }, state, working);
      }
      let factStage: ActivityStage | null = null;
      if (provider !== "codex") {
        // The usage ledger: facts are in once its backfill ends; valuations are ready once every
        // changed source day is reconciled (one primary-key read of the table's change revision).
        const ledger = ledgers ? db.query("SELECT version,covered AS cursor,phase,status,bookmark FROM usage_ledger_state WHERE provider=?")
          .get(provider) as Omit<Scope, "scope"> | null : null;
        if (ledger) {
          const row = { ...ledger, scope: `usage-ledger:${provider}` };
          const caughtUp = ledger.cursor === factTableRevision(db, sourceFor[provider]);
          factStage = observe(`${provider}:facts`, row, ledger.phase === "backfill" ? "backfill" : caughtUp ? "ready" : "replay");
          register = observe(`${provider}:register`, row, ledger.status === "ready" && caughtUp ? "ready"
            : ledger.phase === "reconcile" ? "replay" : "backfill");
        } else factStage = emptyStage("missing");
      }
      result.providers.push({ provider, register, facts: factStage });
    }
    // The period feed's counter is in the progress register; here only whether readings remain.
    periodsPending = accountPeriodFeedBehind(db);
    // The exception answers being computed or failed (data-read.ts); nothing else is queued.
    result.reports.truncated = reports.length > REPORT_LIMIT;
    const views = new Map<ActivityView, AppActivity["reports"]["views"][number]>();
    for (const report of reports.slice(0, REPORT_LIMIT)) {
      const view = viewFor(report.path), counts = views.get(view) ?? { view, pending: 0, failed: 0 };
      if (report.failed) {
        counts.failed++; result.reports.failed++;
        counts.issues ??= [];
        const reason = report.reason ?? "preparation-failed";
        const issue = counts.issues.find(issue => issue.reason === reason);
        if (issue) issue.count++;
        else counts.issues.push({ reason, count: 1 });
      } else { counts.pending++; result.reports.pending++; }
      views.set(view, counts);
    }
    // Most frequent category first, then by name, so the panel's order does not follow request timing.
    for (const counts of views.values()) counts.issues?.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    result.reports.views = [...views.values()];
  } catch {
    // Locked, missing or incompatible metadata is unknown, never an idle/ready assertion.
    result.unavailable = true;
    result.providers = providers.map(provider => ({ provider, register: emptyStage("unavailable"),
      facts: provider === "codex" ? null : emptyStage("unavailable") }));
  }
  result.busy = result.reports.pending > 0 || periodsPending
    || result.progress.some(entry => entry.scope !== "sync" && !entry.scope.startsWith("sync:"))
    || result.providers.some(provider =>
    [provider.register, provider.facts].some(stage => stage !== null && ["pending", "retiring", "backfill", "replay"].includes(stage.state)));
  return result;
}

export function handleAppActivity(db: Database, reports: readonly ReportActivity[] = []): Response {
  return Response.json(readAppActivity(db, Date.now(), reports), { headers: { "Cache-Control": "no-store" } });
}
