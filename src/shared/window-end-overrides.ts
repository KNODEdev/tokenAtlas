import type { WindowEndCause } from "../db/window-end-causes";

/**
 * A person's correction of how a limit window ended (Settings → Accounts → Windows). Only the kind of a real early reset
 * can be corrected: the bonus (1 − f) stays the one the evidence gives, so a correction moves the window's bonus between
 * the reset kinds of its cycle and never adds or removes capacity.
 */
export const CORRECTABLE_CAUSES = ["provider", "provider_probable", "banked", "single", "unknown"] as const satisfies readonly WindowEndCause[];
export type OverrideCause = "provider" | "banked" | "single" | "unknown";
/** The kinds a person may choose: banked credits and single-account resets exist on Codex only. */
export function overrideCauses(provider: string): OverrideCause[] {
  return provider === "codex" ? ["provider", "banked", "single", "unknown"] : ["provider", "unknown"];
}
export const isCorrectable = (cause: string): boolean => (CORRECTABLE_CAUSES as readonly string[]).includes(cause);

export interface WindowEndOverride {
  provider: string; account: string; counter: string; window_start: string; cause: OverrideCause; updated_at: string;
}
export interface WindowEndOverrideStore { revision: string; overrides: WindowEndOverride[] }

/** One main-counter window of an account as Settings lists it. */
export interface AccountWindowEnd {
  account: string; counter: string; window_start: string; window_end: string; planned_reset: string;
  /** The stored cause (a correction once the background step applied it). */
  cause: WindowEndCause;
  /** What the evidence alone says. */
  auto: WindowEndCause;
  /** The person's choice, also while the background step has not applied it yet. */
  override: OverrideCause | null;
}
export interface AccountWindowEnds { revision: string; windows: AccountWindowEnd[]; pending: boolean }
export interface WindowEndOverrideInput { revision: string; account: string; counter: string; window_start: string; cause: OverrideCause | null }

export const overrideKey = (o: Pick<WindowEndOverride, "provider" | "account" | "counter" | "window_start">) =>
  `${o.provider}|${o.account}|${o.counter}|${o.window_start}`;
