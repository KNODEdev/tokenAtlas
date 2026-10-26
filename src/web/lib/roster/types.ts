import type { CreditWindowBasis, CreditFundedSums } from "../../../shared/credit-funded";
import type { CreditPoolsOfRange } from "../../../shared/credit-pools";
import type { UnpricedModel } from "../../../shared/missing-rate";
import type { RosterAccount } from "../api";
import type { Basis, Health, Confidence, AtlasModel } from "../cycle";
import type { ProbeCopy } from "../probe";

export interface RosterSecondWindow {
  label: string;
  usedPercent: number | null;
  elapsedPercent: number | null;
  remainingHours: number | null;
  note: string | null;
}
export interface RosterCard {
  accountSources?: string[];
  id: string;
  vendor: string;
  plan: string | null;
  color: string;
  basis: Basis;
  percentMeasured: boolean;
  /**
   * Cross-machine state of the percent: fresh / stale / measured nowhere.
   * Null only for a vendor that has no probe at all.
   */
  probe: ProbeCopy | null;
  /**
   * True when a probe reading is the ONLY source of `usedPercent`, so a probe
   * that no machine can run means the card has no percent to show.
   */
  percentFromProbe: boolean;
  /** Percent inferred from indexed traffic; never the headline number. */
  estimatePercent: number | null;
  second: RosterSecondWindow | null;
  live: RosterAccount["live"];
  spent: boolean;
  usedPercent: number | null;
  elapsedPercent: number | null;
  ppAhead: number | null;
  paceRatio: number | null;
  paceColor: string;
  projectedEndPercent: number | null;
  remainingHours: number | null;
  resetIso: string | null;
  tokensTotal: number | null;
  tokensFresh: number | null;
  allowanceTokens: number | null;
  usd: number | null;
  /** Unpriced tokens per model inside the window the amount covers; the card marks the missing-rate part. */
  unpricedModels: UnpricedModel[];
  usdAt100: number | null;
  remainingUsd: number | null;
  calls: number | null;
  health: Health | null;
  healthColor: string;
  confidence: Confidence;
  note: string;
  noteLong: string;
  emptyReason: string | null;
  cycleLabel: string;
  group: string;
  windowLabel: string | null;
  shadow: RosterAccount["shadow"];
  model: AtlasModel | null;
  claude: RosterAccount["claude"];
  gemini: RosterAccount["gemini"];
  grok: RosterAccount["grok"];
  glm: RosterAccount["glm"];
  active: boolean;
  vendorAccount: string | null;
  vendorAccountObserved: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
  cycleCount: number;
  /** Credit pools of the current window (Codex, Claude weekly); absent or null when it has none. */
  creditPools?: CreditPoolsOfRange | null;
  /** Codex: the window the balance converts by, and the current window's credit-funded calls. */
  creditBasis?: CreditWindowBasis | null;
  pointBasis?: import("../../../shared/current-point-basis").CurrentPointBasis | null;
  creditFunded?: CreditFundedSums | null;
}
/**
 * Everything a card carries about *whether* and *how long* a subscription ran.
 * The server owns these; the vendor builders never compute them, so they
 * are attached once in buildRoster instead of six times.
 */
export type CardActivity = Pick<
  RosterCard,
  "active" | "vendorAccount" | "vendorAccountObserved" | "firstSeen" | "lastSeen" | "cycleCount"
>;
export type CardCore = Omit<RosterCard, keyof CardActivity>;
export interface RosterGroup {
  key: string;
  label: string;
  /** Live subscriptions — the daily view, and the only ones any aggregate counts. */
  active: RosterCard[];
  /** Closed subscriptions of the same vendor; the rail keeps them behind one collapsed line. */
  inactive: RosterCard[];
}
