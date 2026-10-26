import { useDisclosure } from "../lib/disclosure";
import type { CSSProperties } from "react";
import { CODEX_PROMOTIONS, CODEX_PROMOTIONS_VERIFIED_AT, type CodexPromotion, type CyclePromotion } from "../../shared/codex-promotions";
import { translate, useI18n } from "../lib/i18n";

export function promotionLabel(promotion?: CyclePromotion): string {
  if (promotion?.status === "configured") return promotion.factor === 1
    ? translate("Regular limit · 1×", "Zwykły limit · 1×")
    : `${translate("Promotion", "Promocja")} ${promotion.factor}×`;
  if (promotion?.status === "mixed") return translate("Mixed promotion terms", "Różne warunki promocji");
  if (promotion?.status === "uncertain") return translate("Cycle boundary uncertain", "Niepewna granica cyklu");
  if (promotion?.status === "invalid") return translate("Invalid promotion settings", "Błędne ustawienia promocji");
  return translate("Promotion terms unknown", "Warunki promocji nieustalone");
}

export function PromotionImpactNote({ used, factor }: { used: number; factor: number }) {
  const { t, locale } = useI18n();
  const n = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const equivalent = used * factor, excess = Math.max(0, equivalent - 100);
  return <p>{t("Same work without promotion", "Ta sama praca bez promocji")}: {n(used)}% × {n(factor)} = {n(equivalent)}% {t("of the regular limit", "zwykłego limitu")}; {t("exceed", "ponad limit")}: {n(excess)}%.
    {" " + t("This is an estimate against the regular allowance, not an overage charge or a forecast. Different models, prices, cache and missing logs can also explain capacity changes.", "To szacunek względem zwykłej pojemności, nie dopłata ani prognoza. Różne modele, ceny, cache i brakujące logi również mogą wyjaśniać zmiany pojemności.")}</p>;
}

export function CyclePromotionNote({ promotion }: { promotion?: CyclePromotion }) {
  const { t } = useI18n();
  if (!promotion || promotion.status === "unknown" || promotion.status === "uncertain") return null;
  return <>
    <p>{promotionLabel(promotion)}. {promotion?.status === "configured"
      ? t("Promotion-free estimate = observed capacity ÷ multiplier. Recorded usage and meter percentages stay unchanged. The multiplier is an account declaration, not verified billing.", "Szacunek bez promocji = zaobserwowana pojemność ÷ mnożnik. Zapisane zużycie i procent licznika pozostają bez zmian. Mnożnik to deklaracja dla konta, nie zweryfikowane rozliczenie.")
      : t("No promotion-free estimate: confirm a bounded period for this account and weekly meter in Settings. A cycle crossing different terms is not averaged; no entry does not prove 1×.", "Brak szacunku bez promocji: potwierdź w Ustawieniach okres z obiema datami dla konta i licznika tygodniowego. Nie uśredniamy cyklu przecinającego różne warunki; brak wpisu nie dowodzi 1×.")}</p>
    {promotion?.notes.map((note, index) => <p key={index}>{note}</p>)}
    {promotion?.sources.map(url => <p key={url}><a href={url} target="_blank" rel="noreferrer">{t("Declared source", "Zadeklarowane źródło")}</a></p>)}
  </>;
}

const DAY = 86_400_000;
const KIND_COLOR: Record<CodexPromotion["kind"], string> = {
  reset: "var(--crit)", allowance: "var(--warn)", window: "var(--warn)", discount: "var(--warn)", price: "var(--accent)", policy: "var(--warn)",
};

/**
 * The provider's announcements on one time axis (user, 2026-10-21): a dot per announcement, a bar for a dated period,
 * close ones stacked in lanes. Title, plans and detail are in the tooltip; a click opens the source.
 */
export function CodexPromotionTimeline() {
  const { t, language, locale } = useI18n();
  const items = [...CODEX_PROMOTIONS].map(p => ({ p, start: Date.parse(p.announced_at ?? `${p.announced}T00:00:00Z`), end: p.until ? Date.parse(`${p.until}T00:00:00Z`) + DAY : null }))
    .filter(item => Number.isFinite(item.start)).sort((a, b) => a.start - b.start);
  if (!items.length) return null;
  const first = new Date(items[0]!.start), from = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  const lastTime = Math.max(...items.map(item => item.end ?? item.start)), last = new Date(lastTime);
  const to = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1);
  const x = (time: number) => (time - from) / (to - from) * 100;
  // Lanes: an item joins the first lane whose previous item ended at least 2% of the axis earlier.
  const laneEnds: number[] = [];
  const placed = items.map(item => {
    const left = x(item.start), right = item.end === null ? left : x(item.end);
    let lane = laneEnds.findIndex(end => end + 2 <= left);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(right); } else laneEnds[lane] = right;
    return { ...item, left, right, lane };
  });
  const months: number[] = [];
  for (let month = from; month < to; month = Date.UTC(new Date(month).getUTCFullYear(), new Date(month).getUTCMonth() + 1, 1)) months.push(month);
  const every = months.length > 10 ? 2 : 1;
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
  const legend: Array<[string, string]> = [
    [KIND_COLOR.allowance, t("promotion or limit change", "promocja lub zmiana limitu")],
    [KIND_COLOR.reset, t("reset", "reset")], [KIND_COLOR.price, t("price change", "zmiana cen")],
  ];
  return <div className="capacity-promotion-timeline" style={{ "--lanes": laneEnds.length } as CSSProperties}>
    <div className="capacity-promotion-axis" role="list" aria-label={t("Provider announcements", "Ogłoszenia dostawcy")}>
      {months.map((month, index) => <span key={month} className="capacity-promotion-month" style={{ left: `${x(month)}%` }}>
        {index % every === 0 && <small>{monthLabel.format(month)}</small>}
      </span>)}
      {placed.map(({ p, left, right, lane }) => <a key={p.id} role="listitem" href={p.source} target="_blank" rel="noreferrer"
        className={`capacity-promotion-point${right > left ? " is-period" : ""}`}
        style={{ left: `${left}%`, width: right > left ? `${right - left}%` : undefined, bottom: `calc(var(--s-8) + ${lane} * 14px)`, background: KIND_COLOR[p.kind] }}
        aria-label={`${p.announced} · ${t(p.title.en, p.title.pl)}`}
        title={`${p.announced_at ?? p.announced}${p.until ? ` – ${p.until}` : ""} · ${t(p.title.en, p.title.pl)}\n${p.plans.join(", ")}\n\n${t(p.detail.en, p.detail.pl)}`} />)}
    </div>
    <div className="capacity-legend is-below">{legend.map(([color, label]) => <span key={label}><i className="is-kind" style={{ background: color }} />{label}</span>)}</div>
  </div>;
}

export function CodexPromotionHistory({ onUse }: { onUse?: (id: string) => void }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useDisclosure("capacity:promotions");
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="capacity-detail">
    <summary>{t("Historical promotions and sources", "Historyczne promocje i źródła")}</summary>
    <p>{t("Reviewed", "Sprawdzono")}: {CODEX_PROMOTIONS_VERIFIED_AT}. {t("This list is not a complete entitlement history. The dated Pro $100 launch offer is matched automatically to historical 5× plans; other announcements remain context.", "Lista nie jest kompletną historią uprawnień. Promocja premierowa Pro 100 USD jest automatycznie dopasowana do historycznych planów 5×; pozostałe ogłoszenia stanowią kontekst.")}</p>
    {CODEX_PROMOTIONS.map(p => <div key={p.id} className="capacity-promotion-source">
      <strong>{p.announced}{p.until ? ` – ${p.until}` : ""} · {t(p.title.en, p.title.pl)}</strong>
      <p>{p.plans.join(", ")} · {t(p.detail.en, p.detail.pl)} <a href={p.source} target="_blank" rel="noreferrer">{t("Source", "Źródło")}</a></p>
      {onUse && p.kind === "allowance" && <button type="button" onClick={() => onUse(p.id)}>{t("Use as an unconfirmed draft", "Użyj jako niepotwierdzonego szkicu")}</button>}
    </div>)}
  </details>;
}
