import type { AppContext } from "../../src/server/api";
import { CODEX_COUNTERS, isCodexWindowMinutes } from "../../src/shared/codex-counters";
import type { CodexComparisonWindow } from "../../src/shared/codex-accounting";
import type { CapacityCyclesEntry, CapacityCyclesResponse } from "../../src/shared/capacity-cycles";
import { parseCapacityCounter } from "../../src/shared/manual-capacity";
import { codexCapacityCycles } from "../../src/server/codex-accounting";
import { subscriptionCapacityCycles } from "../../src/server/subscription-accounting";
import { ledgerProviderOf, subscriptionAccountingAdapter } from "../../src/server/subscription-accounting-adapters";
import { readManualCapacity } from "../../src/server/manual-capacity";
import { ProbeAccountIndexUnavailable } from "../../src/server/current/probe-account-reader";
import { loadPlans } from "../../src/server/plans";
import { loadPlansCatalog } from "../../src/server/plans-catalog";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The register provider of a declared subscription: Codex or a shared-ledger provider (as window-screens.ts). */
function providerOf(vendor: string | undefined): string | null {
  const name = (vendor || "codex").toLowerCase();
  return ["codex", "openai"].includes(name) ? "codex" : ledgerProviderOf(name)?.id ?? null;
}
/** Whether a register provider has an accounting report (Codex, or a shared-ledger adapter). */
function accountingProvider(provider: string): boolean {
  if (provider === "codex") return true;
  try { subscriptionAccountingAdapter(provider); return true; } catch { return false; }
}
const counterLabel =(counter: string) => {
  const parts = parseCapacityCounter(counter);
  return parts ? [parts[0], parts[1], `${parts[2]}m`].filter(Boolean).join(" · ") : counter;
};

/**
 * Every subscription's cycles of one window length over whole UTC days, for the capacity comparison (Global
 * capacity): the stored register (limit_windows) and its stored sums (window_usage), shaped exactly as each
 * provider's accounting report shapes its windows. Nothing is derived from calls and nothing waits: an account
 * whose sums are not stored yet is `preparing`, every other one is answered.
 */
export function capacityCyclesReference(ctx: AppContext, url: URL): Response {
  const since = url.searchParams.get("since") ?? "", until = url.searchParams.get("until") ?? "";
  const minutes = Number(url.searchParams.get("window_minutes") ?? 10080);
  if (!DAY.test(since) || !DAY.test(until) || since > until) return Response.json({ error: "Expected since and until as YYYY-MM-DD" }, { status: 400 });
  if (!isCodexWindowMinutes(minutes)) return Response.json({ error: "Expected window_minutes 300 or 10080 or 43200" }, { status: 400 });
  const range = { since, until };
  const plans = ctx.plans ?? loadPlans(), catalog = ctx.plansCatalog ?? loadPlansCatalog();
  const manual = new Map<string, ReturnType<typeof readManualCapacity>["measurements"]>();
  const accounts: CapacityCyclesEntry[] = [];
  // Declared subscriptions and every account the register holds windows for (a discovered one is listed on the screen too).
  const subjects = new Map<string, string>();
  for (const subscription of ctx.accounts.subscriptions ?? []) {
    const provider = providerOf(subscription.vendor);
    if (provider) subjects.set(subscription.id.toLowerCase(), provider);
  }
  for (const row of ctx.sqlite.query("SELECT DISTINCT provider, account FROM limit_windows").all() as Array<{ provider: string; account: string }>)
    if (!subjects.has(row.account) && accountingProvider(row.provider)) subjects.set(row.account, row.provider);
  for (const [account, provider] of subjects) {
    if (account.endsWith("::business")) continue;
    const read = (counter: string, label: string, windows: () => CodexComparisonWindow[]) => {
      const base = { account, provider, counter, counter_label: label, windows: [] as CodexComparisonWindow[] };
      try { accounts.push({ ...base, windows: windows() }); }
      catch (error) {
        if (error instanceof ProbeAccountIndexUnavailable) accounts.push({ ...base, preparing: true });
        else accounts.push({ ...base, error: error instanceof Error ? error.message : String(error) });
      }
    };
    if (provider === "codex") {
      const counter = CODEX_COUNTERS[minutes];
      read(counter.id, counter.label, () => codexCapacityCycles(ctx.sqlite, account, minutes, range, plans, catalog, ctx.eras));
      continue;
    }
    // The counters of this window length: the stored register's and the manual measurements' of the days.
    const measurements = manual.get(provider) ?? readManualCapacity(provider).measurements;
    manual.set(provider, measurements);
    const counters = new Set((ctx.sqlite.query("SELECT DISTINCT counter FROM limit_windows WHERE provider=? AND account=?")
      .all(provider, account) as Array<{ counter: string }>).map(row => row.counter));
    for (const m of measurements) if (m.account === account && Date.parse(m.end) >= Date.parse(since)
      && Date.parse(m.start) < Date.parse(until) + 86_400_000) counters.add(m.counter);
    // Only the provider's accounting counters, as its report lists them (Claude's per-model weekly limit is not one).
    const kinds = subscriptionAccountingAdapter(provider).counterKinds;
    const matching = [...counters].filter(counter => {
      const parts = parseCapacityCounter(counter);
      return parts?.[2] === minutes && kinds.includes(parts[0]);
    }).sort();
    const before = accounts.length;
    for (const counter of matching) read(counter, counterLabel(counter), () => subscriptionCapacityCycles(
      { ...ctx, plans, plansCatalog: catalog, manualCapacity: measurements, declarations: ctx.accounts.subscriptions },
      provider, account, counter, range));
    // A counter without cycles in the days says nothing; one entry keeps the account visible as "no cycles".
    const answered = accounts.splice(before);
    const kept = answered.filter(entry => entry.windows.length || entry.preparing || entry.error);
    accounts.push(...(kept.length ? kept : [{ account, provider, counter: "", counter_label: "", windows: [], unavailable: true as const }]));
  }
  const body: CapacityCyclesResponse = { since, until, window_minutes: minutes, accounts };
  return Response.json(body);
}
