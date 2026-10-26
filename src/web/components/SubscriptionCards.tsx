import { useCallback, useState } from "react";
import type { ProbeReadingState } from "../lib/api";
import type { ProbeCopy } from "../lib/probe";
import type { RosterCard } from "../lib/roster";
import { groupRoster, providerColor, subscriptionName } from "../lib/roster";
import { compact, duration, full, pct, usd } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { SUBS_RAIL_W } from "../lib/useBreakpoint";
import { Dropdown, HelpDot } from "./ui";
import "./Rail.css";
import "./SubscriptionCards.css";
import { SubscriptionRailSettings } from "./SubscriptionRailSettings";
import { subscriptionPlan } from "../lib/subscription-plan";
import { missingRateAmountTitle, missingRateIn, useMissingRates } from "../lib/missing-rate";
import { creditCardView } from "../lib/credit-pools-view";
import { PoolFacts } from "./PoolFacts";
function confidenceLabel(confidence: string): string {
  if (confidence === "high") return translate("calibration: high confidence", "kalibracja: wysoka pewność");
  if (confidence === "medium") return translate("calibration: medium confidence", "kalibracja: średnia pewność");
  if (confidence === "low") return translate("calibration: low confidence", "kalibracja: niska pewność");
  return translate("no tokens/% calibration", "brak kalibracji tokens/%");
}
export const INACTIVE_EXPANDED_KEY = "tokenatlas.rail.inactive";
/** Per-vendor expansion of the archive, remembered across reloads; default collapsed. */
function readExpanded(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(INACTIVE_EXPANDED_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) if (value === true) out[key] = true;
    }
  } catch {
  }
  return out;
}
function writeExpanded(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(INACTIVE_EXPANDED_KEY, JSON.stringify(state));
  } catch {
  }
}
/** „1 nieaktywna / 2 nieaktywne / 5 nieaktywnych" — the badge word declined, not templated. */
export function inactiveCountLabel(n: number): string {
  const last = n % 10;
  const teens = n % 100;
  if (n === 1) return `1 ${translate("inactive", "nieaktywna")}`;
  if (last >= 2 && last <= 4 && (teens < 12 || teens > 14)) return `${n} ${translate("inactive", "nieaktywne")}`;
  return `${n} ${translate("inactive", "nieaktywnych")}`;
}
const ISO_DAY = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—");
const PRODUCT_NAMES: Record<string, string> = {
  codex: "OpenAI / Codex", openai: "OpenAI / Codex", claude: "Anthropic / Claude",
  anthropic: "Anthropic / Claude", gemini: "Google / Gemini", grok: "xAI / Grok",
  glm: "Z.ai / GLM", opencode: "OpenCode", all: "All subscriptions",
};
export function productName(vendor: string): string {
  return vendor === "all" ? translate("All", "Wszystkie") : PRODUCT_NAMES[vendor] ?? vendor;
}
function basisLabel(basis: RosterCard["basis"]): string {
  if (basis === "gauge") return translate("from account", "z konta");
  if (basis === "inferred") return translate("estimate", "szacunek");
  return translate("declared", "zadeklarowane");
}
export const RAIL_ORDER_KEY = "tokenatlas.rail.order";
export const RAIL_HIDDEN_KEY = "tokenatlas.rail.hidden.v1";
function readOrder(key = RAIL_ORDER_KEY): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  } catch { return []; }
}
function ordered<T>(items: T[], order: string[], key: (item: T) => string): T[] {
  const rank = (item: T) => { const index = order.indexOf(key(item)); return index < 0 ? Infinity : index; };
  return [...items].sort((a, b) => rank(a) - rank(b));
}
/**
 * An API-equivalent amount that leaves out tokens of a model without a price: the priced part followed by
 * "+ no price", or "no price" alone when nothing in the window is priced. No price is estimated.
 */
export function MissingRateAmount({ usd: amount, missing }: { usd: number | null; missing: boolean }) {
  const { t } = useI18n();
  if (missing && !(amount != null && amount > 0)) return <span data-missing-rate className="is-warn">{t("no price", "brak ceny")}</span>;
  return <>
    <span className={amount != null ? "sub-card-money" : undefined}>{usd(amount)}</span>
    {missing && <span data-missing-rate className="is-warn"> + {t("no price", "brak ceny")}</span>}
  </>;
}
function AccountSubtitle({ card }: { card: RosterCard }) {
  if (card.vendor === "all") return null;
  const sources = card.accountSources?.length
    ? translate("Windows sources: {0}", `Źródła Windows: ${card.accountSources.join(", ")}`, [card.accountSources.join(", ")])
    : null;
  return <div data-account-subtitle className="sub-card-account" title={[subscriptionName(card), card.id, sources].filter(Boolean).join(" · ")}>{subscriptionName(card)}</div>;
}
export function SubscriptionCards({
  cards,
  selected,
  onSelect,
  columns,
}: {
  cards: RosterCard[];
  selected: string;
  onSelect: (id: string) => void;
  columns: number;
}) {
  useI18n();
  if (cards.length === 0) return null;
  return (
    <section className="sub-card-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(columns, cards.length))}, minmax(0, 1fr))` }}>
      {cards.map((c) =>
        c.active ? (
          <SubscriptionCard key={c.id} card={c} selected={c.id === selected} onSelect={onSelect} />
        ) : (
          <InactiveSubscriptionCard key={c.id} card={c} selected={c.id === selected} onSelect={onSelect} />
        )
      )}
    </section>
  );
}
export function SubscriptionRail({
  cards,
  selected,
  onSelect,
  width = SUBS_RAIL_W,
  headerHeight = 52,
  compact = false,
}: {
  cards: RosterCard[];
  selected: string;
  onSelect: (id: string) => void;
  width?: number;
  headerHeight?: number;
  /** Smaller desktop screens: each row keeps name, account, percentage, pace and meter. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [vendor, setVendor] = useState("all");
  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState(readOrder);
  const [hidden, setHidden] = useState(() => readOrder(RAIL_HIDDEN_KEY));
  const toggleHidden = (key: string) => {
    const next = hidden.includes(key) ? hidden.filter(item => item !== key) : [...hidden, key];
    setHidden(next);
    try { localStorage.setItem(RAIL_HIDDEN_KEY, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
  };
  const visibleCards = cards.filter(card => card.vendor === "all" || (!hidden.includes(`group:${card.group}`) && !hidden.includes(`card:${card.id}`)));
  const groups = ordered(groupRoster(cards), order, (g) => `group:${g.key}`);
  const activeVendor = groups.some((g) => g.key === vendor) ? vendor : "all";
  const move = (keys: string[], index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= keys.length) return;
    const next = [...keys];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    const saved = [...next, ...order.filter((key) => !next.includes(key))];
    setOrder(saved);
    try { localStorage.setItem(RAIL_ORDER_KEY, JSON.stringify(saved)); } catch { /* Storage can be unavailable. */ }
  };
  if (cards.length === 0) return null;
  const subscriptions = cards.filter(card => card.vendor !== "all").length;
  const vendors = groups.filter(g => g.key !== "all").length;
  return (
    <aside className={`subs-rail${compact ? " is-compact" : ""}`} style={{ width, flexBasis: width, top: headerHeight, height: `calc(100vh - ${headerHeight}px)` }}>
      <div className="rail-head">
        <div className="rail-head-row">
          <span className="rail-caption">{t("Subscriptions", "Subskrypcje")}</span>
          <HelpDot label={t("Shared axis", "Wspólna oś")}>{t("Own-window percentage is the only shared axis. Tokens do not share one axis. Codex and grok count cache reads inside input, Claude separately, and gemini does not provide them.", "Procent własnego okna to jedyna wspólna oś. Tokeny nie mają jednej wspólnej osi. Codex i grok liczą odczyty cache wewnątrz inputu, Claude osobno, a gemini nie podaje ich wcale.")}</HelpDot>
          <button type="button" data-rail-settings aria-haspopup="dialog" aria-expanded={editing} className="rail-icon-button"
            aria-label={t("Subscription settings", "Ustawienia subskrypcji")} title={t("Subscription settings", "Ustawienia subskrypcji")}
            onClick={() => setEditing(true)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M2 4h12M2 12h12" /><path d="M5 2v4M11 10v4" strokeWidth="3" />
            </svg>
          </button>
        </div>
        <Dropdown data-provider-filter ariaLabel={t("Filter by provider", "Filtruj po dostawcy")} value={activeVendor}
          onChange={value => setVendor(value)} className="rail-sub rail-filter"
          options={["all", ...groups.filter((g) => g.key !== "all").map((g) => g.key)].map((key) => ({ value: key, label: key === "all"
            ? `${subscriptions} ${t("subscriptions", "subskrypcji")} · ${vendors} ${t("vendors", "dostawców")}`
            : productName(key) }))} />
      </div>
      <div className="rail-groups">
        <GroupedCards cards={visibleCards} selected={selected} onSelect={onSelect} vendor={activeVendor} order={order} />
        {!visibleCards.some(card => card.vendor !== "all" && (activeVendor === "all" || card.group === activeVendor)) &&
          <div className="rail-empty">{t("All accounts in this view are hidden. Restore them in subscription settings.", "Wszystkie konta w tym widoku są ukryte. Przywróć je w ustawieniach subskrypcji.")}</div>}
      </div>
      {editing && <SubscriptionRailSettings onClose={() => setEditing(false)} move={move} hidden={hidden} toggleHidden={toggleHidden}
        groups={groups.filter(g => g.key !== "all").map(g => ({ key: `group:${g.key}`, label: productName(g.key),
          accounts: [...ordered(g.active, order, c => `card:${c.id}`), ...ordered(g.inactive, order, c => `card:${c.id}`)]
            .map(c => ({ key: `card:${c.id}`, label: subscriptionName(c), active: c.active,
              source: c.accountSources?.join(", ") || c.id, plan: subscriptionPlan(c.vendor, c.plan) })) }))} />}
    </aside>
  );
}
function GroupedCards({
  cards,
  selected,
  onSelect,
  vendor, order,
}: {
  cards: RosterCard[];
  selected: string;
  onSelect: (id: string) => void;
  vendor: string;
  order: string[];
}) {
  const { t } = useI18n();
  const groups = ordered(groupRoster(cards), order, (g) => `group:${g.key}`).sort((a, b) => Number(b.key === "all") - Number(a.key === "all"));
  const renderCards = (items: RosterCard[]) => {
    const sorted = ordered(items, order, (c) => `card:${c.id}`);
    return sorted.map((c) => <div key={c.id} data-subscription={c.id}>
      {c.active ? <SubscriptionCard card={c} selected={c.id === selected} onSelect={onSelect} />
        : <InactiveSubscriptionCard card={c} selected={c.id === selected} onSelect={onSelect} />}
    </div>);
  };
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedInactive, setExpandedInactive] = useState<Record<string, boolean>>(readExpanded);
  const toggleInactive = useCallback((key: string) => {
    setExpandedInactive((prev) => {
      const next = { ...prev, [key]: prev[key] !== true };
      if (!next[key]) delete next[key];
      writeExpanded(next);
      return next;
    });
  }, []);
  return (
    <>
      {groups.map((g) => {
        if (vendor !== "all" && g.key !== vendor) return null;
        const single = g.active.length === 1 && g.inactive.length === 0;
        const isCollapsed = collapsed[g.key] === true;
        const showInactive = expandedInactive[g.key] === true;
        const worst = g.active.reduce<RosterCard | null>(
          (a, c) => (c.usedPercent != null && (a == null || a.usedPercent == null || c.usedPercent > a.usedPercent) ? c : a),
          null
        );
        const spent = g.active.filter((c) => c.spent).length;
        return (
          <div key={g.key} className="rail-group">
            {!single && (
              <button type="button" onClick={() => setCollapsed((p) => ({ ...p, [g.key]: !isCollapsed }))} className="rail-group-head" aria-expanded={!isCollapsed}
                title={`${g.active.length} ${t("active windows from this provider. Click to collapse.", "aktywnych okien tego dostawcy. Kliknij, żeby zwinąć.")}`}>
                <span className="rail-group-label">{g.label}</span>
                <span className="rail-group-sub">{g.active.length > 0 ? g.active.length : ""}{isCollapsed ? " ›" : ""}</span>
                {spent > 0 && <span className="rail-group-sub is-crit">{spent} {t("exhausted", "wyczerpanych")}</span>}
                {worst?.usedPercent != null && (
                  <span className={`rail-group-sub${worst.usedPercent >= 80 ? " is-warn" : ""}`}
                    title={`${t("Highest usage in this family", "Najwyższe zużycie w tej rodzinie")}: ${worst.id}. ${t("Percentages from different windows do not add up, so the header shows the worst one, not the sum.", "Procenty różnych okien się NIE sumują, więc nagłówek pokazuje najgorsze, nie sumę.")}`}>
                    {t("max", "max")} {pct(worst.usedPercent)}
                  </span>
                )}
              </button>
            )}
            {!isCollapsed && renderCards(g.active)}
            {!isCollapsed && g.inactive.length > 0 && (
              <InactiveGroupLine count={g.inactive.length} expanded={showInactive} onToggle={() => toggleInactive(g.key)} />
            )}
            {!isCollapsed && showInactive && renderCards(g.inactive)}
          </div>
        );
      })}
    </>
  );
}
export function InactiveGroupLine({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button type="button" data-inactive-line={count} onClick={onToggle} className="rail-inactive-line" aria-expanded={expanded}
      title={t("Subscriptions with closed eras. Click to show their history. Selection works like an active subscription.", "Subskrypcje z zamkniętymi erami. Kliknij, żeby pokazać ich historię. Wybór działa jak dla aktywnej.")}>
      <span>{expanded ? "−" : "+"}</span>
      <span>{inactiveCountLabel(count)}</span>
    </button>
  );
}
/**
 * The archive card: identity, span and how many cycles it lived — no percent and
 * no pace bar, because a closed subscription has no running window to be a
 * fraction of. Selecting it is a full selection, exactly like an active card.
 */
export function InactiveSubscriptionCard({
  card,
  selected,
  onSelect,
}: {
  card: RosterCard;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const range = `${ISO_DAY(card.firstSeen)} → ${ISO_DAY(card.lastSeen)}`;
  return (
    <button type="button" data-inactive-card={card.id} onClick={() => onSelect(card.id)} className="sub-card is-inactive" aria-pressed={selected}
      title={`${t("Inactive subscription. All eras are closed.", "Subskrypcja nieaktywna. Wszystkie ery zamknięte.")} ${t("Observed", "Obserwowana")} ${range}, ${card.cycleCount} ${t("cycles", "cykli")}. ${t("Click to open its history.", "Kliknij, żeby przejść do jej historii.")}`}>
      <div className="sub-card-row">
        <span className="sub-card-dot" style={{ background: providerColor(card.vendor) }} />
        <span className="sub-card-name" title={`${subscriptionName(card)} · ${card.id}`}>{productName(card.vendor)}</span>
        <span className="sub-card-plan">{t("inactive", "nieaktywna")}</span>
        {card.plan && <span className="sub-card-aside">{subscriptionPlan(card.vendor, card.plan)}</span>}
      </div>
      <AccountSubtitle card={card} />
      <div className="sub-card-row is-meta">
        <span>{range}</span>
        <span title={t("Number of weekly cycles during which this subscription was probed.", "Liczba tygodniowych cykli, przez które ta subskrypcja była sondowana.")}>
          {card.cycleCount} {t("cycles", "cykli")}
        </span>
      </div>
    </button>
  );
}
/**
 * The three probe states must be told apart without colour: the glyph carries
 * the state, the colour only reinforces it.
 */
const PROBE_GLYPH: Record<ProbeReadingState, string> = { fresh: "●", stale: "◐", none: "○" };

function ProbeStatus({ probe }: { probe: ProbeCopy }) {
  return (
    <span data-probe={probe.state} className={probe.state === "stale" ? "is-warn" : probe.state === "none" ? "is-muted" : ""} title={probe.detail}>
      <span aria-hidden="true">{PROBE_GLYPH[probe.state]}</span> {probe.status}
    </span>
  );
}

function ResetTime({ hours }: { hours: number | null }) {
  return <span data-reset-time>{hours != null ? duration(hours) : "—"}</span>;
}
function Meter({ used, elapsed, color, dim }: { used: number | null; elapsed: number | null; color: string; dim?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="sub-card-bar">
      {used != null && <span className="is-fill" style={{ right: `${100 - Math.min(100, used)}%`, background: color, opacity: dim ? 0.45 : 1 }} />}
      {elapsed != null && <span className="is-elapsed" style={{ left: `${Math.min(100, elapsed)}%` }} title={`${pct(elapsed)} ${t("of window time has passed", "czasu okna minęło")}`} />}
    </span>
  );
}
function SubscriptionCard({
  card,
  selected,
  onSelect,
}: {
  card: RosterCard;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const used = card.usedPercent;
  const elapsed = card.elapsedPercent;
  const hasData = used != null;
  const isAll = card.vendor === "all";
  const probe = card.probe;
  const stale = probe?.state === "stale";
  const estimate = hasData ? null : card.estimatePercent;
  // The $ fallback only makes sense while the probe state is not itself the
  // story; once no machine measures this window, the reason is the card.
  const noGauge = card.grok != null && !hasData && estimate == null && probe?.state !== "none";
  const missing = missingRateIn(card.unpricedModels, useMissingRates());
  const second = card.second;
  const secondColor =
    second?.usedPercent == null
      ? "var(--faint)"
      : second.usedPercent >= 100
        ? "var(--crit)"
        : second.usedPercent >= 85
          ? "var(--warn)"
          : providerColor(card.vendor);
  return (
    <button type="button" onClick={() => onSelect(card.id)} className="sub-card" aria-pressed={selected} title={card.noteLong}>
      <div className="sub-card-row">
        <span className="sub-card-dot" style={{ background: providerColor(card.vendor) }} />
        <span className="sub-card-name" title={`${subscriptionName(card)} · ${card.id}`}>{productName(card.vendor)}</span>
        {card.plan && <span className="sub-card-plan">{subscriptionPlan(card.vendor, card.plan)}</span>}
        <span className={`sub-card-aside${card.basis === "declared" ? " sub-card-declared" : ""}`}
          title={card.live ? card.noteLong : card.basis === "gauge" ? confidenceLabel(card.confidence) : card.noteLong}>{basisLabel(card.basis)}</span>
      </div>
      <AccountSubtitle card={card} />
      <div className="sub-card-row is-value">
        <span className={`sub-card-pct${card.spent ? " is-spent" : noGauge ? " is-money" : stale ? " is-stale" : ""}`}
          title={noGauge ? t("xAI does not publish a limit counter, and grok-gauge.json has no reading from which to derive a scale.", "xAI nie publikuje licznika limitu, a grok-gauge.json nie ma jeszcze odczytu, z którego dałoby się wyprowadzić skalę.") : undefined}>
          {noGauge ? usd(card.usd) : hasData ? pct(used) : "—"}
        </span>
        {estimate != null && (
          <span data-estimate className="sub-card-estimate" title={t("Estimate from indexed traffic in this window. It is not an account reading.", "Szacunek z zaindeksowanego ruchu w tym oknie. Nie odczyt z konta.")}>
            {t("estimate", "szacunek")} {pct(estimate)}
          </span>
        )}
        <span className="sub-card-note">
          {card.spent
            ? t("exhausted", "wyczerpany")
            : noGauge
              ? t("xAI pricing · scale unavailable", "wycena xAI · brak skali")
              : isAll
                ? hasData
                  ? `${t("average", "średnio")} · ${pct(elapsed)} ${t("of time", "czasu")}`
                  : card.emptyReason ?? t("no data", "brak danych")
                : hasData
                  ? `${t("used", "użycie")} · ${pct(elapsed)} ${t("of time", "czasu")}${card.windowLabel ? ` · ${card.windowLabel}` : ""}`
                  : card.emptyReason ?? t("no data", "brak danych")}
        </span>
        <span className="sub-card-pace" style={{ color: card.paceColor }}
          title={card.paceRatio != null ? `${pct(used)} ${t("usage at", "zużycia przy")} ${pct(elapsed)} ${t("of window time", "czasu okna")}` : undefined}>
          {card.paceRatio != null ? `${card.paceRatio.toFixed(2)}×` : "—"}
        </span>
      </div>
      {!noGauge && <Meter used={used} elapsed={elapsed} color={card.spent ? "var(--crit)" : providerColor(card.vendor)} dim={stale} />}
      <div className="sub-card-row is-meta">
        {!noGauge ? <span>{t("reset", "reset")} <ResetTime hours={card.remainingHours} /></span> : <span />}
        {probe != null
          ? <ProbeStatus probe={probe} />
          : <span title={card.live ? card.noteLong : card.basis === "gauge" ? confidenceLabel(card.confidence) : card.noteLong}>{card.note}</span>}
      </div>
      {probe?.trail && <div data-probe-trail className={`sub-card-line${probe.state === "none" ? " is-wrap" : ""}`} title={probe.trail}>{probe.trail}</div>}
      {second != null && (
        <div data-second-window className="sub-card-second"
          title={
            second.usedPercent == null
              ? `${t("Window", "Okno")} ${second.label}: ${second.note ?? t("no reading", "brak odczytu")}`
              : `${t("Window", "Okno")} ${second.label}: ${pct(second.usedPercent)} ${t("usage", "zużycia")}${
                  second.elapsedPercent != null ? ` ${t("at", "przy")} ${pct(second.elapsedPercent)} ${t("of window time", "czasu okna")}` : ""
                }${second.remainingHours != null ? ` · ${t("reset", "reset")} ${duration(second.remainingHours)}` : ""}`
          }>
          <span>{second.label}</span>
          <b style={{ color: secondColor }}>{second.usedPercent != null ? pct(second.usedPercent) : "—"}</b>
          <Meter used={second.usedPercent} elapsed={second.elapsedPercent} color={secondColor} />
          <ResetTime hours={second.remainingHours} />
        </div>
      )}
      <div className="sub-card-row is-usage">
        <span
          title={
            isAll
              ? t("Gross tokens from different vendors do not add up to one number. Codex counts cache reads inside input, Claude separately. The per-subscription breakdown is on the ALL screen.", "Tokeny brutto różnych vendorów nie sumują się do jednej liczby. Codex liczy odczyty cache wewnątrz inputu, Claude osobno. Zestawienie per subskrypcja jest na ekranie ALL.")
              : card.tokensTotal != null
                ? `${full(card.tokensTotal)} ${t("gross tokens in this window", "tokenów brutto w tym oknie")}`
                : undefined
          }
        >
          {isAll ? t("breakdown", "zestawienie") : card.tokensTotal != null ? `${compact(card.tokensTotal)} ${t("tokens", "tokenów")}` : card.gemini ? t("history unavailable", "brak historii") : `— ${t("tokens", "tokenów")}`}
        </span>
        <span title={missing.tokens > 0 ? missingRateAmountTitle(missing.models) : t("API equivalent: traffic priced using the API catalog. What this window would cost without a subscription.", "API-equivalent: wycena ruchu wg cennika API. Ile to okno kosztowałoby bez abonamentu.")}>
          <MissingRateAmount usd={card.usd} missing={missing.tokens > 0} /> {card.grok ? "xAI" : "API-eq"}
        </span>
      </div>
      <CreditPoolBlock card={card} />
    </button>
  );
}
/**
 * The account's credits under the card (mockup 2, accepted 10.10): the balance as a figure with its value in windows
 * and dollars, a bar of the balance in windows, free resets as dots; Claude's dollar packages in the same structure.
 * Nothing without a pool.
 */
function CreditPoolBlock({ card }: { card: RosterCard }) {
  useI18n();
  const view = creditCardView(card.creditPools, card.creditBasis, { usedPercent: card.usedPercent, creditFunded: card.creditFunded });
  if (!view) return null;
  return (
    <div data-credit-pools className="sub-card-pool" title={view.title}>
      {view.pools.map(pool => <PoolFacts key={pool.key} pool={pool} compact />)}
      {view.resets && <div className="sub-card-pool-line">
        <span><span className="sub-card-pool-dots">{Array.from({ length: Math.min(5, view.resets.dots) }, (_, index) => <i key={index} />)}</span>{view.resets.left}</span>
        {view.resets.right && <span>{view.resets.right}</span>}
      </div>}
    </div>
  );
}
