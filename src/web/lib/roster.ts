import type { RosterAccount, RosterProbe, RosterResponse } from "./api";
import { vendorShade } from "./model-colors";
import { probeCopy } from "./probe";
import { claudeCard } from "./roster/claude";
import { gaugeCard } from "./roster/codex";
import { geminiCard } from "./roster/gemini";
import { glmCard } from "./roster/glm";
import { grokCard } from "./roster/grok";
import { paceColorOf, vendorColor } from "./roster/presentation";
import type { CardActivity, CardCore, RosterCard } from "./roster/types";

export { type RosterSecondWindow, type RosterCard, type RosterGroup } from "./roster/types";
export { subscriptionName, subscriptionNameLookup, providerColor } from "./roster/presentation";
export { ALL_ACCOUNT, selectedAccountId, preferredAccountOrder, buildAllCard, groupRoster } from "./roster/aggregate";

function activityOf(a: RosterAccount): CardActivity {
  return {
    active: a.active !== false,
    vendorAccount: a.vendor_account ?? null,
    vendorAccountObserved: a.vendor_account_source === "observed",
    firstSeen: a.first_seen ?? null,
    lastSeen: a.last_seen ?? null,
    cycleCount: a.cycle_count ?? 0,
  };
}
/**
 * The three card states live in one place, not in six vendor builders: the
 * builder says where the percent came from, this says whether any machine still
 * measures it. A percent measured nowhere is removed rather than shown stale
 * forever, and the reason takes its place.
 */
function applyProbe(core: CardCore, probe: RosterProbe | null, nowMs: number): CardCore {
  if (!probe) return core;
  const copy = probeCopy(probe, nowMs);
  if (copy.state !== "none") return { ...core, probe: copy };
  // No machine has ever written a sample under this name. That is not enough to
  // erase a percent the card got from somewhere else — say so, keep the number.
  const probed = probe.machines.length > 0;
  if (core.usedPercent != null && (!core.percentFromProbe || !probed)) return { ...core, probe: copy };
  return {
    ...core,
    probe: copy,
    usedPercent: null,
    percentMeasured: false,
    ppAhead: null,
    paceRatio: null,
    paceColor: paceColorOf(null),
    spent: false,
    // The vendor's own short reason stays the subtitle; the probe trail below it
    // says which machines tried and how they failed.
    emptyReason: core.emptyReason ?? copy.line,
  };
}
export function buildRoster(res: RosterResponse, nowMs = Date.now()): RosterCard[] {
  let codexSeen = 0;
  let geminiSeen = 0;
  return res.accounts.map((a) => {
    const activity = activityOf(a);
    const card = (core: CardCore): RosterCard => ({ ...applyProbe(core, a.probe, nowMs), ...activity, accountSources: a.account_sources });
    if (a.glm) return card(glmCard(a, "var(--glm)"));
    if (a.basis === "quota" || a.gemini)
      return card(geminiCard(a, vendorShade("var(--gemini)", geminiSeen++)));
    if (a.basis === "spend" || a.grok) return card(grokCard(a, "var(--grok)"));
    const color = vendorColor(a, codexSeen);
    if (a.basis === "declared" || a.claude) return card(claudeCard(a, color, nowMs));
    codexSeen += 1;
    return card(gaugeCard(a, color, res.window_minutes));
  });
}
