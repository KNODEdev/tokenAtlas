import { useEffect, useState } from "react";
import type { CurrentEnvelope, CurrentLimit, CurrentSubscription, BootstrapData } from "../lib/current-contract";
import { getLocale, useI18n } from "../lib/i18n";
import { subscriptionPlan } from "../lib/subscription-plan";
import { Card, CardTitle, EmptyState, Eyebrow, GhostButton, Pill } from "./ui";

const dateTime = (value: string) => new Date(value).toLocaleString(getLocale());
function lifecycleLabel(value: CurrentSubscription["lifecycle"], t: (en: string, pl: string) => string): string {
  return ({
    active: t("active", "aktywna"),
    paused: t("paused", "wstrzymana"),
    cancelled: t("cancelled", "zakończona"),
    unknown: t("status unknown", "status nieokreślony"),
  } as Record<string, string>)[value] ?? value;
}
export function CurrentLimitView({ limit, vendor = "", offline = false }: { limit: CurrentLimit; vendor?: string; offline?: boolean }) {
  const { t } = useI18n();
  // The reset can pass while the connection is offline: never retain the old percentage as current.
  const expired = limit.freshness === "expired" || (limit.resets_at != null && Date.parse(limit.resets_at) <= Date.now());
  const uncertain = expired || limit.freshness === "conflict" || limit.freshness === "clock-skew";
  const used = uncertain ? null : limit.used_percent;
  const status = expired ? t("after reset - waiting for a reading", "po resecie — oczekiwanie na odczyt") : limit.freshness === "conflict" ? t("conflicting readings", "sprzeczne odczyty")
    : limit.freshness === "clock-skew" ? t("clock mismatch", "niezgodny zegar") : offline ? t("saved reading - offline", "zapisany odczyt — offline")
    : limit.freshness === "stale" ? t("stale reading", "odczyt nieświeży") : t("measured", "pomiar");
  return <div style={{ padding: "var(--s-6) 0", borderTop: "var(--rule)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--s-4)", flexWrap: "wrap" }}>
      <div><Eyebrow>{[limit.group, limit.scope, limit.kind].filter(Boolean).join(" · ")}</Eyebrow>
        <div className="ui-figure" style={{ fontSize: "var(--fs-8)", margin: "var(--s-2) 0" }}>
          {used != null ? `${used.toLocaleString(getLocale(), { maximumFractionDigits: 1 })}%`
            : !uncertain && limit.used != null ? limit.used.toLocaleString(getLocale()) : "—"}
          <span style={{ fontFamily: "var(--font-sans)", fontSize: "var(--fs-3)", fontWeight: "var(--fw-regular)", letterSpacing: 0, color: "var(--muted)", marginLeft: "var(--s-4)" }}>
            {used != null ? t("used", "wykorzystano") : !uncertain && limit.used != null ? t("counter units", "jednostek licznika") : t("no current value", "brak bieżącej wartości")}
          </span>
        </div>
      </div>
      <Pill tone={uncertain || offline || limit.freshness === "stale" ? "warn" : "neutral"}><span style={{ whiteSpace: "normal" }}>{status}</span></Pill>
    </div>
    {used != null && <div role="meter" aria-label={`${limit.kind}: ${t("allowance used", "wykorzystanie limitu")}`} aria-valuemin={0} aria-valuemax={Math.max(100, used)} aria-valuenow={Math.max(0, used)}
      style={{ height: 6, boxSizing: "border-box", background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden", margin: "var(--s-2) 0 var(--s-4)" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, used))}%`, height: "100%", background: used >= 90 ? "var(--warn)" : "var(--accent)" }} />
    </div>}
    <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.7 }}>
      <div>{t("Measured", "Pomiar")}: {dateTime(limit.measured_at)} · {t("probe", "sonda")}: {limit.machine ?? t("unknown machine", "nieznana maszyna")}</div>
      <div>{t("Reset", "Reset")}: {limit.resets_at ? dateTime(limit.resets_at) : t("unknown", "nieznany")}{limit.plan ? ` · ${t("observed plan", "plan zaobserwowany")}: ${subscriptionPlan(vendor, limit.plan, limit.measured_at)}` : ""}</div>
    </div>
  </div>;
}
export function CurrentSubscriptionCard({ subscription: sub, onSelect, onHistory, offline = false }: {
  subscription: CurrentSubscription; onSelect?: () => void; onHistory: () => void; offline?: boolean;
}) {
  const { t } = useI18n();
  return <Card>
    <CardTitle title={sub.label} sub={`${sub.vendor} · ${sub.id}`} right={<Pill>{lifecycleLabel(sub.lifecycle, t)}</Pill>} />
    <p style={{ fontSize: "var(--fs-4)", color: "var(--muted)", margin: "var(--s-5) 0" }}>
      {sub.account_identity ? `${sub.account_identity} · ${t("declared account identity", "tożsamość zadeklarowana")}` : t("Account identity unknown", "Tożsamość konta nieustalona")}
    </p>
    {!sub.binding_active && <p style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>{t("No active source binding. This does not mean the subscription was cancelled.", "Brak aktywnego powiązania ze źródłem. Nie oznacza to anulowania subskrypcji.")}</p>}
    {sub.declaration_conflict && <p role="alert" style={{ color: "var(--warn)", fontSize: "var(--fs-4)" }}>{t("Attribution is uncertain or being updated. Readings are hidden until it is resolved.", "Atrybucja jest niepewna lub w trakcie aktualizacji. Odczyty ukryto do rozstrzygnięcia.")}</p>}
    {sub.clock_warning && <p role="status" style={{ color: "var(--warn)", fontSize: "var(--fs-4)" }}>{t("A future reading does not replace the last valid reading.", "Pomiar z przyszłości nie zastępuje ostatniego poprawnego odczytu.")}</p>}
    {sub.latest_error && <p role="status" style={{ color: "var(--warn)", fontSize: "var(--fs-4)" }}>
      {t("The last probe attempt failed", "Ostatnia próba sondy nie powiodła się")} ({dateTime(sub.latest_error.measured_at)}). {t("The previous valid reading was kept.", "Zachowano wcześniejszy poprawny pomiar.")}
    </p>}
    {!sub.limits.length && <p style={{ fontSize: "var(--fs-4)", padding: "var(--s-8) 0", color: "var(--muted)" }}>{t("No assigned reading. This does not mean 0% used.", "Brak przypisanego pomiaru. To nie oznacza 0% zużycia.")}</p>}
    {sub.limits.map((limit) => <CurrentLimitView key={limit.key} limit={limit} vendor={sub.vendor} offline={offline} />)}
    {sub.limits_truncated && <p style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>{t("Only some counters are shown.", "Pokazano część liczników.")}{onSelect ? ` ${t("Open the subscription to see more.", "Otwórz subskrypcję, aby zobaczyć więcej.")}` : ` ${t("The rest are available in history.", "Pozostałe są dostępne w historii.")}`}</p>}
    <div style={{ display: "flex", gap: "var(--s-4)", marginTop: "var(--s-5)", flexWrap: "wrap" }}>
      {onSelect && <GhostButton onClick={onSelect}>{t("Current limits", "Bieżące limity")} →</GhostButton>}
      <GhostButton onClick={onHistory}>{t("History and comparisons", "Historia i porównania")}</GhostButton>
    </div>
  </Card>;
}
export function CurrentOverview({ snapshot, onSelect, onHistory, offline = false }: {
  snapshot: CurrentEnvelope<BootstrapData | CurrentSubscription>;
  onSelect: (id: string) => void; onHistory: (id: string) => void; offline?: boolean;
}) {
  const { t } = useI18n();
  // A hung/offline request must not keep a pre-reset percentage on screen indefinitely.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const portfolio = "subscriptions" in snapshot.data;
  const subscriptions = "subscriptions" in snapshot.data ? snapshot.data.subscriptions : [snapshot.data];
  return <>
    {snapshot.status !== "ready" && <Card><div role="status" style={{ fontSize: "var(--fs-4)", color: "var(--muted)" }}>
      {snapshot.status === "initializing" ? t("Preparing the persistent current state. Subscriptions are already available; history does not block this screen.", "Trwa przygotowanie trwałego stanu bieżącego. Subskrypcje są już dostępne; historia nie blokuje tego ekranu.")
        : snapshot.status === "error" ? (snapshot.error_code === "migration-required"
          ? t("The current state requires a database migration (bun run db:migrate) and an application restart.", "Stan bieżący wymaga migracji bazy (bun run db:migrate) i ponownego uruchomienia aplikacji.")
          : t("The state update needs attention. Available readings retain their own dates and quality labels.", "Aktualizacja stanu wymaga uwagi. Dostępne pomiary zachowują własne daty i oznaczenia jakości."))
        : t("Updating the projection. The readings below are the latest published ones, not a full new generation.", "Trwa aktualizacja projekcji. Poniżej ostatnio opublikowane odczyty, nie pełna nowa generacja.")}
    </div></Card>}
    {!subscriptions.length && <EmptyState title={t("No declared subscriptions", "Brak zadeklarowanych subskrypcji")} detail={t("Add subscriptions in Settings or configure sources. No data does not mean zero usage.", "Dodaj subskrypcje w Ustawieniach lub skonfiguruj źródła. Brak danych nie oznacza zerowego zużycia.")} />}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: "var(--s-8)", alignItems: "start" }}>
      {subscriptions.map((sub) => <CurrentSubscriptionCard key={sub.id} subscription={sub} offline={offline}
        onSelect={portfolio ? () => onSelect(sub.id) : undefined} onHistory={() => onHistory(sub.id)} />)}
    </div>
    <div className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.8 }}>
      {snapshot.generated_at ? `${t("Projection", "Projekcja")}: ${dateTime(snapshot.generated_at)} · ${t("generation", "generacja")} ${snapshot.generation}. ` : `${t("Projection not published yet.", "Projekcja jeszcze nieopublikowana.")} `}
      {t("Each counter has its own measurement time. Subscription limits and sub-limits are not summed or averaged.", "Każdy licznik ma własny czas pomiaru. Limitów subskrypcji i podlimitów nie sumujemy ani nie uśredniamy.")}
    </div>
  </>;
}
