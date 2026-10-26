import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import type { CapacityAccount, CapacityAccountResult } from "./global-capacity";
import { vendorColor, vendorShade } from "./model-colors";
import { modelSelected, type SpeedSelection } from "./model-speed";

/**
 * The global capacity comparison: cycles of chosen subscriptions on one scale. The choice has the shape of Speed's
 * (subscriptions left out, inactive ones opted in, and per subscription the cycles left out), so a new cycle is shown.
 */
export const COMPARE_SELECTION_KEY = "tokenatlas.capacity.compare-selection.v1";
export const COMPARE_PROVIDERS = ["codex", "claude", "gemini", "grok", "glm"] as const;
const PROVIDER_NAMES: Readonly<Record<string, string>> = { codex: "Codex", claude: "Claude", gemini: "Gemini", grok: "Grok", glm: "GLM" };
export const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;

/** Subscriptions with a percentage allowance: Business bills credits only, other providers have no meter. */
export function comparableAccounts(accounts: CapacityAccount[]): CapacityAccount[] {
  return accounts.filter(account => !account.id.endsWith("::business") && (COMPARE_PROVIDERS as readonly string[]).includes(account.provider));
}

/** Each subscription takes a shade of its provider's hue in a fixed order, so its colour does not depend on what else is chosen. */
export function subscriptionColors(accounts: CapacityAccount[]): Map<string, string> {
  const rank = new Map<string, number>();
  const colors = new Map<string, string>();
  for (const account of [...accounts].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))) {
    const index = rank.get(account.provider) ?? 0;
    rank.set(account.provider, index + 1);
    colors.set(account.id, vendorShade(vendorColor(account.provider) ?? "var(--accent)", index));
  }
  return colors;
}

const cycleStart = (window: CodexComparisonWindow) => Date.parse(window.cycle_start ?? window.start);

/** A subscription's cycles in the range, oldest first (one account can have more than one counter of a length). */
export function accountCycles(results: readonly CapacityAccountResult[]): CodexComparisonWindow[] {
  return results.flatMap(result => result.windows).sort((a, b) => cycleStart(a) - cycleStart(b));
}

/** The chosen cycles of every chosen subscription, oldest first, each with the subscription it came from. */
export function chosenCycles(results: ReadonlyMap<string, readonly CapacityAccountResult[]>, accounts: readonly CapacityAccount[],
  selection: SpeedSelection, inactive: ReadonlySet<string>): Array<{ account: CapacityAccount; window: CodexComparisonWindow }> {
  return accounts.flatMap(account => accountCycles(results.get(account.id) ?? [])
    .filter(window => modelSelected(selection, account.id, window.id, inactive))
    .map(window => ({ account, window })))
    .sort((a, b) => cycleStart(a.window) - cycleStart(b.window));
}

/** Leaves out the given cycles of a subscription; the ones already left out stay so. */
export function leaveOutCycles(selection: SpeedSelection, account: string, cycles: readonly string[]): SpeedSelection {
  if (!cycles.length) return selection;
  const left = Object.prototype.hasOwnProperty.call(selection.models, account) ? selection.models[account]! : [];
  return { ...selection, models: { ...selection.models, [account]: [...new Set([...left, ...cycles])] } };
}
