import type { CodexComparisonWindow, TimelineMarker, TimelineMarkersResponse } from "../../shared/codex-accounting";
import { translate, useI18n } from "../lib/i18n";
import { priceChangeFor } from "../../shared/codex-price-changes";
import { CodexPriceChangeDetails } from "./CodexPriceChangeDetails";
import { ConfiguredPriceDetails } from "./ConfiguredPriceDetails";
import { COMPLETED_PROVIDER_RESETS } from "../../shared/completed-provider-resets";
import { CODEX_PROMOTIONS } from "../../shared/codex-promotions";
import { alignProviderResetMarkers } from "../lib/capacity-reset-markers";
import { useState } from "react";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import "./CapacityEventDetails.css";

export const isProviderResetMarker = (marker: TimelineMarker): boolean => marker.id.startsWith("reset:");
export const isCycleResetMarker = (marker: TimelineMarker): boolean => isProviderResetMarker(marker) && !!marker.reset_boundary;
export const isPromotionMarker = (marker: TimelineMarker): boolean => marker.id.startsWith("promotion:");
export const isPolicyMarker = (marker: TimelineMarker): boolean => CODEX_PROMOTIONS.some(p => p.kind === "policy" && marker.id === `promotion:${p.id}:announcement`);

export function capacityMarkers(data: TimelineMarkersResponse | null, since: string, until: string, provider = "codex", now = Date.now(), windows: readonly CodexComparisonWindow[] = []): TimelineMarker[] {
  const markers = new Map(data?.automatic.map(m => [m.id, m]));
  for (const marker of data?.markers ?? []) {
    const automatic = markers.get(marker.id);
    markers.set(marker.id, { ...marker, observed_at: undefined, pricing: automatic?.day === marker.day ? automatic.pricing : undefined });
  }
  for (const reset of COMPLETED_PROVIDER_RESETS) {
    if (reset.provider !== provider || Date.parse(reset.at) > now) continue;
    const marker: TimelineMarker = {
      id: `reset:${reset.id}`, day: reset.at.slice(0, 10), observed_at: reset.at,
      label: translate("Global reset", "Globalny reset"), color: "crit", visible: true,
      note: `${translate("Provider-reported completed global reset. Time of the public confirmation, not proof of receipt by this account. Source:", "Wykonany globalny reset potwierdzony przez dostawcę. Czas publicznego potwierdzenia, nie dowód otrzymania resetu na tym koncie. Źródło:")} ${reset.source}`,
    };
    markers.set(marker.id, marker);
  }
  if (provider === "codex") for (const promotion of CODEX_PROMOTIONS) {
    if (!["allowance", "discount", "window", "policy"].includes(promotion.kind)) continue;
    const title = translate(promotion.title.en, promotion.title.pl);
    const note = [
      `${translate("Announcement", "Ogłoszenie")}: ${promotion.announced}.`,
      `${translate("Plans", "Plany")}: ${promotion.plans.join(", ")}.`,
      ...(promotion.kind === "policy" ? [] : [promotion.until ? `${translate("Through (inclusive)", "Do (włącznie)")}: ${promotion.until}.` : translate("End date unconfirmed.", "Data końca niepotwierdzona.")]),
      translate(promotion.detail.en, promotion.detail.pl),
      `${translate("Source", "Źródło")}: ${promotion.source}`,
    ].join(" ");
    const dates = [{ suffix: "announcement", day: promotion.announced, label: `${promotion.kind === "policy" ? translate("Plan change announced", "Ogłoszenie zmiany planu") : translate("Promotion announced", "Ogłoszenie promocji")} · ${title}` }];
    if (promotion.until) dates.push({ suffix: "end", day: new Date(Date.parse(promotion.until) + 86_400_000).toISOString().slice(0, 10),
      label: `${translate("Promotion ended", "Koniec promocji")} · ${title}` });
    for (const date of dates) {
      const observed_at = date.suffix === "announcement" ? promotion.announced_at : undefined;
      if (Date.parse(observed_at ?? date.day) > now) continue;
      const marker: TimelineMarker = { id: `promotion:${promotion.id}:${date.suffix}`, day: date.day, observed_at, label: date.label, note, color: "warn", visible: true };
      markers.set(marker.id, marker);
    }
  }
  return alignProviderResetMarkers([...markers.values()], windows).filter(m => m.visible && m.day >= since && m.day <= until).sort((a, b) => markerTimestamp(a) - markerTimestamp(b));
}

export function markerTimestamp(marker: TimelineMarker): number {
  const boundary = isProviderResetMarker(marker) ? marker.reset_boundary?.at : undefined;
  const preferred = Date.parse(boundary ?? marker.observed_at ?? `${marker.day}T00:00:00Z`);
  return Number.isFinite(preferred) ? preferred : Date.parse(marker.day);
}

export function markerUtcLabel(marker: TimelineMarker): string {
  if (isProviderResetMarker(marker) && marker.reset_boundary) return `${marker.reset_boundary.at.replace("T", " ").replace("Z", " UTC")} · ${translate("cycle start; public confirmation", "początek cyklu; publiczne potwierdzenie")}: ${marker.observed_at?.replace("T", " ").replace("Z", " UTC")}`;
  if (isPromotionMarker(marker) && !marker.observed_at) return `${marker.day} UTC · ${translate("date only; time not published", "tylko data; godzina nieopublikowana")}`;
  if (marker.pricing?.length) {
    const boundary = `${marker.day} 00:00 UTC · ${translate("configured date boundary", "skonfigurowana granica daty")}`;
    return priceChangeFor(marker)
      ? `${boundary} · ${translate("announcement hour not published", "godzina ogłoszenia nieopublikowana")}`
      : boundary;
  }
  if (priceChangeFor(marker)) return `${marker.day} UTC · ${translate("time not published", "godzina nieopublikowana")}`;
  const timestamp = markerTimestamp(marker);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().replace("T", " ").replace("Z", " UTC")
    : `${marker.day} UTC`;
}

// The server names configured price points "<model> · configured price change" (Codex) or "<model> · API price change".
const CONFIGURED_PRICE_LABEL = /^(.+) · (?:configured|API) price change$/;

/** The model of a configured price point that still carries the server's English label; null otherwise, e.g. after an edit. */
export function configuredPriceModel(marker: TimelineMarker): string | null {
  return marker.id.startsWith("price:configured:") ? CONFIGURED_PRICE_LABEL.exec(marker.label)?.[1] ?? null : null;
}

/** The marker's label in the interface language; edited and curated labels are shown as written. */
export function markerDisplayLabel(marker: TimelineMarker): string {
  if (isProviderResetMarker(marker) && marker.reset_boundary === null) return translate("Global reset · boundary unobserved", "Globalny reset · brak odczytu granicy");
  if (isProviderResetMarker(marker)) return translate("Global reset", "Globalny reset");
  const model = configuredPriceModel(marker);
  return model === null ? marker.label : `${model} · ${translate("configured price change", "skonfigurowana zmiana cen")}`;
}

export function markerKindLabel(marker: TimelineMarker): string {
  if (isPolicyMarker(marker)) return translate("plan change announcement; account transition unverified", "ogłoszenie zmiany planu; przejście konta niepotwierdzone");
  if (isProviderResetMarker(marker) && marker.reset_boundary === null) return translate("public reset confirmation; no matching observed cycle", "publiczne potwierdzenie resetu; brak dopasowanego cyklu");
  if (isProviderResetMarker(marker)) return translate("completed global provider reset", "wykonany globalny reset dostawcy");
  if (isPromotionMarker(marker)) return marker.id.endsWith(":end")
    ? translate("confirmed promotion end date", "potwierdzona data końca promocji")
    : translate("promotion announcement; account eligibility not established", "ogłoszenie promocji; uprawnienie konta nieustalone");
  const priceChange = priceChangeFor(marker);
  if (marker.id.startsWith("price:configured:")) return translate("configured API price change · subscription impact unverified", "skonfigurowana zmiana cen API · wpływ na abonament niepotwierdzony");
  if (marker.pricing?.length) return priceChange
    ? translate("configured pricing · actual app rates + announcement reference", "skonfigurowany cennik · rzeczywiste stawki aplikacji + odniesienie do ogłoszenia")
    : translate("configured pricing · actual app rates", "skonfigurowany cennik · rzeczywiste stawki aplikacji");
  if (priceChange) return priceChange.includedUsage === "declared_change"
    ? translate("price change · included-usage impact declared", "zmiana cen · wpływ na zużycie abonamentu zadeklarowany")
    : translate("price change · subscription impact unverified", "zmiana cen · wpływ na abonament niepotwierdzony");
  if (!marker.id.startsWith("model:")) return translate("event", "zdarzenie");
  return marker.observed_at && Number.isFinite(Date.parse(marker.observed_at))
    ? translate("first observed in archive", "pierwsza obserwacja w archiwum")
    : translate("model date (edited or manual)", "data modelu (edytowana lub ręczna)");
}

function EventNote({ note }: { note: string }) {
  return <>{note.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={index}>
    {paragraph.split(/(https?:\/\/[^\s]+)/g).map((part, index) => {
      if (!/^https?:\/\//.test(part)) return part;
      const url = part.replace(/[.,;:!?)]+$/, "");
      return <span key={index}><a href={url} target="_blank" rel="noreferrer">{url}</a>{part.slice(url.length)}</span>;
    })}
  </p>)}</>;
}

/** One note reader for chart markers, cycle dividers and the event list. */
export function useCapacityEventDrawer() {
  const { t, language } = useI18n();
  const [selected, setSelected] = useState<{ markers: TimelineMarker[]; opener: Pick<HTMLElement, "focus"> } | null>(null);
  return {
    openEvents: (markers: TimelineMarker[], opener: Pick<HTMLElement, "focus">) => setSelected({ markers, opener }),
    eventDrawer: selected && <div data-capture-exclude=""><AccountPeriodDrawer title={t("Event details", "Szczegóły wydarzenia")}
      subtitle={selected.markers.map(markerDisplayLabel).join(" · ")} busy={false}
      closeLabel={t("Close event details", "Zamknij szczegóły wydarzenia")} className="ui-detail-drawer capacity-event-drawer"
      returnFocus={selected.opener} onClose={() => setSelected(null)}>
      {selected.markers.map(marker => {
        const change = priceChangeFor(marker);
        const promotion = CODEX_PROMOTIONS.find(p => marker.id === `promotion:${p.id}:announcement` || marker.id === `promotion:${p.id}:end`);
        return <section key={marker.id}>
          <h3 style={{ color: `var(--${marker.color})` }}>{markerDisplayLabel(marker)}</h3>
          <p className="mono">{markerUtcLabel(marker)}</p>
          <p>{markerKindLabel(marker)}</p>
          {marker.note && <EventNote note={marker.note} />}
          {!!promotion?.official_sources?.length && <section aria-label={t("Official sources", "Oficjalne źródła")}>
            <h4>{t("Official sources", "Oficjalne źródła")}</h4>
            <ul>{promotion.official_sources.map(source => <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">{t(source.label.en, source.label.pl)}</a>
            </li>)}</ul>
          </section>}
          {marker.pricing?.length ? <ConfiguredPriceDetails pricing={marker.pricing} /> : null}
          {change && <CodexPriceChangeDetails change={change} />}
        </section>;
      })}
    </AccountPeriodDrawer></div>,
  };
}

export function CapacityMilestones({ markers }: { markers: TimelineMarker[] }) {
  const { t } = useI18n();
  const { openEvents, eventDrawer } = useCapacityEventDrawer();
  if (!markers.length) return null;
  const hasConfiguredPricing = markers.some(marker => marker.pricing?.length);
  return <div className="capacity-milestones" title={hasConfiguredPricing
    ? t("Model dates are first archive observations, not launch dates, unless edited. Configured pricing dates are UTC day boundaries; announcement hours may be unpublished.", "Daty modeli to pierwsze obserwacje w archiwum, nie daty premiery, o ile nie zostały edytowane. Daty skonfigurowanego cennika są granicami dni UTC; godziny ogłoszeń mogą być nieopublikowane.")
    : t("Model dates are first archive observations, not launch dates, unless edited", "Daty modeli to pierwsze obserwacje w archiwum, nie daty premiery, o ile nie zostały edytowane")}>
    <div>{markers.map((m, i) => {
      const change = priceChangeFor(m);
      const label = <><b style={{ color: `var(--${m.color})` }}>{i + 1}</b> {markerDisplayLabel(m)} · {markerUtcLabel(m)} · {markerKindLabel(m)}</>;
      const configuredPricing = m.pricing?.length ? <div>
        <strong>{t("Configured app pricing · actual dated rules", "Skonfigurowany cennik aplikacji · rzeczywiste reguły datowane")}</strong>
        <ConfiguredPriceDetails pricing={m.pricing} />
      </div> : null;
      const announcement = change ? <div>
        <strong>{t("Announcement reference · separate evidence", "Odniesienie do ogłoszenia · osobny dowód")}</strong>
        <CodexPriceChangeDetails change={change} />
      </div> : null;
      if (configuredPricing || announcement) return <details className="capacity-detail" key={m.id} style={{ flexBasis: "100%" }}><summary>{label}</summary>{configuredPricing}{announcement}</details>;
      return <button type="button" className="ui-open-row-button" key={m.id} title={m.note} aria-haspopup="dialog"
        onClick={event => openEvents([m], event.currentTarget)}>{label}</button>;
    })}</div>
    {eventDrawer}
  </div>;
}
