import type { ReactNode } from "react";
import type { ClaudeLimitResponse } from "../lib/api";
import { claudeReading } from "../lib/claude";
import { compact, dayTime, duration, full, pct, polishPlural, relativeTime, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { missingRateAmountTitle, missingRateIn, missingRateNote, useMissingRates } from "../lib/missing-rate";
import { subscriptionPlan } from "../lib/subscription-plan";
import type { WindowInsight } from "../lib/window-insights";
import type { CoursePoint } from "../lib/window-status";
import type { RailWindow } from "../lib/windows";
import { ACCENT_SOFT, Chip, CreditStrip, MachineRow, StatRow, StatusFrame, Stack, Track, WindowChart, WindowCreditsSection, mini } from "./WindowStatusCard";
import { accountCredits, creditStripView, poolFundingTitle, poolLabel, windowCreditRows } from "../lib/credit-pools-view";
import { EstimateTag, Eyebrow, Pill } from "./ui";
import type { ChartUnit } from "../lib/window-units";
import { grantPoolEvidence } from "../../shared/pool-usage";

type Current = NonNullable<ClaudeLimitResponse["current"]>;
const HOUR_MS = 3_600_000;
const SAME_INSTANT_MS = 30 * 60_000;
// Claude has no credit rate card: its chart counts the meter, tokens and API dollars.
const CLAUDE_UNITS: readonly ChartUnit[] = ["pct", "tokens", "usd"];

export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = a ? Date.parse(a) : NaN, tb = b ? Date.parse(b) : NaN;
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= SAME_INSTANT_MS;
}

/** The reported weekly window with the numbers the status block and the forecast tab share. */
export interface ClaudeWindowModel {
  cur: Current;
  active: boolean;
  used: number | null;
  /** `used` is an account reading (not a manual measurement or a computed estimate). */
  measured: boolean;
  /** `used` is the newest reading of a manual measurement. */
  manual: boolean;
  /** When `used` was read; null for a computed estimate. */
  readAt: string | null;
  /** Closed window below 100%: hours from its newest reading to its end, when no reading covers them. */
  unreadHours: number | null;
  /** The account's plan period over this window; falls back to the configured plan. */
  plan: string | null;
  /** The rail's weekly counter for this very window: measured course, typical forecast, machines. */
  weekly: WindowInsight | null;
  startMs: number;
  spanHours: number;
  resetMs: number;
  reading: CoursePoint;
  typicalEnd: number | null;
  linearEnd: number | null;
  pace: number | null;
  perHour: number | null;
  remainingPerHour: number | null;
  exhaustionIso: string | null;
}

export function claudeWindowModel(cur: Current, windowHours: number, insights: WindowInsight[], plan: string | null, nowMs = Date.now()): ClaudeWindowModel {
  const reading = claudeReading(cur);
  const startMs = Date.parse(cur.window_start);
  const resetMs = Date.parse(cur.reset_at);
  // After a plan-change drop the server reports the segment, so its span is shorter than the plan window.
  const spanHours = cur.elapsed_hours + cur.remaining_hours;
  const candidates = insights.filter((i) => !i.isSublimit && i.current.windowHours === windowHours
    && sameInstant(i.current.startIso, cur.window_start));
  const weekly = candidates.find((i) => sameInstant(i.current.resetIso, cur.reset_at)) ?? candidates[0] ?? null;
  const active = !(Number.isFinite(resetMs) && resetMs <= nowMs) && (weekly == null || weekly.current.isCurrent);
  // A closed window keeps the rail's newest reading of its span. The live window reads the account,
  // unless the rail holds a newer reading of it (a limit refusal logged after the last account read)
  // or the account gave no reading of it at all.
  const railNewer = weekly?.current.sampledAtIso != null && (!reading.measured || cur.measured_at == null
    || Date.parse(weekly.current.sampledAtIso) > Date.parse(cur.measured_at));
  const railReading = weekly?.current.usedPercent != null && (!active || railNewer) ? weekly.current : null;
  const used = railReading ? railReading.usedPercent : reading.percentAll;
  const measured = railReading ? railReading.percentBasis === "measured" : reading.measured;
  const readAt = railReading ? railReading.sampledAtIso : reading.measured ? cur.measured_at : null;
  const baseline = cur.counter_reset?.first_after.percent ?? 0;
  const measuredMs = readAt ? Date.parse(readAt) : NaN;
  const unreadMs = !active && !weekly?.current.activity && used != null && used < 99.5 && Number.isFinite(measuredMs) ? resetMs - measuredMs : NaN;
  const readingT = Number.isFinite(measuredMs) && spanHours > 0
    ? Math.max(0, Math.min(100, ((measuredMs - startMs) / (spanHours * HOUR_MS)) * 100)) : cur.elapsed_percent;
  const etaMs = cur.eta_100_iso ? Date.parse(cur.eta_100_iso) : NaN;
  return {
    cur, active, used, measured, manual: railReading?.percentBasis === "manual", readAt,
    unreadHours: unreadMs > 0 ? unreadMs / HOUR_MS : null,
    plan: weekly?.current.plan ?? plan, weekly, startMs, spanHours, resetMs,
    reading: { t: readingT, pct: used ?? 0 },
    typicalEnd: active ? weekly?.forecastPercent ?? null : null,
    linearEnd: active ? cur.projected_end_percent : null,
    pace: active ? reading.paceRatio : null,
    perHour: used != null && cur.elapsed_hours > 0 ? Math.max(0, used - baseline) / cur.elapsed_hours : null,
    remainingPerHour: active && used != null && cur.remaining_hours > 0 ? Math.max(0, 100 - used) / cur.remaining_hours : null,
    exhaustionIso: active && etaMs > nowMs && etaMs < resetMs ? cur.eta_100_iso : null,
  };
}

/**
 * Claude Overview's first block in the Codex block's language: the weekly window's headline
 * numbers and course, every account counter (session, week, sub-limits, dollar and extra meters)
 * and this window's indexed traffic.
 */
export function ClaudeStatusCard({ data, model, insights, account, selectedHistorical, meters, creditPools = null, chartControl, chartOverride }: {
  data: ClaudeLimitResponse; model: ClaudeWindowModel; insights: WindowInsight[]; account: string;
  selectedHistorical: boolean;
  /** The account's other meters from the weekly window's newest reading. */
  meters: RailWindow["accountMeters"];
  /** The weekly window's credit pools and their movement in it. */
  creditPools?: RailWindow["creditPools"];
  /** The project picker, at the right end of the chart's unit row. */
  chartControl?: ReactNode;
  /** Replaces the course chart; it then carries `chartControl` itself. */
  chartOverride?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const { cur, active, used, weekly } = model;
  const reading = claudeReading(cur);
  const drop = cur.counter_reset ?? null;
  const plan = subscriptionPlan("claude", model.plan, cur.window_start.slice(0, 10)) ?? t("plan unknown", "plan nieznany");
  const title = data.window_hours === 168 ? t("7d week", "Tydzień 7d") : `${t("Window", "Okno")} ${duration(data.window_hours)}`;
  const serverStart = new Date(model.resetMs - data.window_hours * HOUR_MS).toISOString();
  const cached = Math.max(0, cur.spend.gross - cur.spend.fresh);
  const unpriced = cur.spend.unpriced_calls ?? 0;
  const missingRate = missingRateIn(cur.unpriced_models, useMissingRates());
  const money = (value: number | null) => value == null ? "—" : `$${value.toLocaleString(locale, { maximumFractionDigits: 2 })}`;
  const shownMeters = selectedHistorical ? null : meters ?? null;
  const accountCredit = accountCredits(creditPools);
  // Calls the vendor billed from a promotional grant; their valuation, never the account debit.
  const grant = cur.credit_funded ?? null;
  const otherMeters = shownMeters?.meters.filter(meter => !creditPools?.pools.some(pool => pool.key === `claude:${meter.key}`)) ?? [];
  const counterName = (insight: WindowInsight) => insight.isSublimit ? `↳ ${insight.label}`
    : insight.current.windowHours === 5 ? t("5h session", "Sesja 5h")
    : insight.current.windowHours === 168 ? t("7d week", "Tydzień 7d") : insight.label;

  const chips: ReactNode[] = [];
  if (drop) chips.push(<Chip key="drop" tone="var(--warn)" soft="var(--warn-soft)" title={t(
    "The weekly counter fell from {0}% ({1}) to {2}% ({3}) without moving its reset: a plan change or a reset. The server still reports the window start {4}; usage, time and pace count from the first reading after the drop. The earlier segment is in Periods → Limit windows.",
    `Licznik tygodniowy spadł z ${drop.last_before.percent}% (${dayTime(drop.last_before.at)}) do ${drop.first_after.percent}% (${dayTime(drop.first_after.at)}) bez zmiany resetu: zmiana planu albo reset. Serwer nadal podaje start okna ${dayTime(serverStart)}; zużycie, czas i tempo liczone od pierwszego odczytu po spadku. Poprzedni odcinek jest w Okresy → Okna limitu.`, [drop.last_before.percent, dayTime(drop.last_before.at), drop.first_after.percent, dayTime(drop.first_after.at), dayTime(serverStart)])}>
    ↓ {t("7d counter", "licznik 7d")} {drop.last_before.percent}% → {drop.first_after.percent}% · {t("plan change", "zmiana planu")} {dayTime(drop.first_after.at)}
  </Chip>);
  if (model.manual && model.readAt) chips.push(<Chip key="manual" tone="var(--warn)" soft="var(--warn-soft)" title={t(
    "The newest reading of this window comes from a manual measurement (Capacity → manual readings), not from the account.",
    "Najnowszy odczyt tego okna pochodzi z ręcznego pomiaru (Pojemność → pomiary ręczne), nie z konta.")}>
    ≈ {t("manual reading", "pomiar ręczny")} {pct(used)} · {dayTime(model.readAt)}</Chip>);
  else if (!model.measured && used != null) chips.push(<Chip key="estimate" tone="var(--warn)" title={reading.noteLong}>
    ≈ {t("computed percentage, not an account reading", "procent wyliczony, nie odczyt z konta")}</Chip>);
  if (model.unreadHours != null && model.unreadHours > 2 && model.readAt) chips.push(<Chip key="unread" tone="var(--warn)" soft="var(--warn-soft)" title={t(
    "No account reading covers the last {0} of this window, so its result may be higher than {1}.",
    `Żaden odczyt konta nie obejmuje ostatnich ${duration(model.unreadHours)} tego okna, więc jego wynik mógł być wyższy niż ${pct(used)}.`, [duration(model.unreadHours), pct(used)])}>
    ⓘ {t("last reading", "ostatni odczyt")} {pct(used)} · {dayTime(model.readAt)} · {duration(model.unreadHours)} {t("unread until the end", "bez odczytu do końca")}</Chip>);

  return (
    <StatusFrame
      title={title}
      meta={active ? undefined : <span className="sub-card-plan">{plan}</span>}
      startIso={cur.window_start} endIso={cur.reset_at}
      read={model.measured && model.readAt
        ? <span title={dayTime(model.readAt)}>{t("% read", "% odczyt")} {relativeTime(model.readAt)}</span>
        : model.manual && model.readAt ? <>{t("manual reading", "pomiar ręczny")} {dayTime(model.readAt)}</>
        : <EstimateTag title={reading.noteLong}>{t("computed percentage", "procent wyliczony")}</EstimateTag>}
      chips={chips}
      strip={<CreditStrip view={creditStripView(accountCredit)} />}
      kpis={{
        active, usedPercent: used, usedEstimated: !model.measured, elapsedPercent: cur.elapsed_percent,
        leftNote: cur.remaining_usd != null ? `${usd(cur.remaining_usd)} API-eq` : null,
        remainingHours: cur.remaining_hours, elapsedHours: cur.elapsed_hours,
        resetIso: cur.reset_at, endedIso: cur.reset_at,
        resetNote: sameInstant(data.probe.weekly_resets_at, cur.reset_at) ? null : t("inferred", "wywnioskowane"),
        typicalEnd: model.typicalEnd, linearEnd: model.linearEnd, baselineCount: weekly?.baselineCount ?? 0,
        pace: model.pace, perHour: model.perHour, remainingPerHour: model.remainingPerHour,
      }}
      chart={chartOverride ?? (weekly
        ? <WindowChart control={chartControl} startMs={model.startMs} spanMs={model.spanHours * HOUR_MS} endMs={model.resetMs} active={active}
          insight={weekly} reading={model.reading} linearEnd={model.linearEnd} exhaustionIso={model.exhaustionIso}
          tokensByDay={cur.days ? new Map(cur.days.map((d) => [d.date, d.tokens])) : null}
          units={{ options: CLAUDE_UNITS, input: { startMs: model.startMs, spanMs: model.spanHours * HOUR_MS, pools: creditPools,
            blocks: cur.hours ?? null, usedPercent: used, atLimit: null, creditFunded: null,
            fundedPool: grantPoolEvidence(cur.credit_funded, creditPools), windowTokens: cur.spend.gross,
            counted: { tokens: cur.spend.gross, usd: cur.spend.usd, usd_partial: (cur.spend.unpriced_calls ?? 0) > 0 } } }} />
        : <>{chartControl && <div className="ui-toolbar"><span style={{ marginLeft: "auto" }}>{chartControl}</span></div>}
          <div className="mono" style={{ alignSelf: "center", textAlign: "center", fontSize: "var(--fs-4)", color: "var(--muted)" }}>
            {t("No account readings of this window's course yet.", "Brak odczytów konta z przebiegu tego okna.")}</div></>)}
      aside={<>
        <div>
          <Eyebrow>{t("Counters", "Liczniki")}</Eyebrow>
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "86px minmax(60px, 1fr) auto 72px", gap: "var(--s-4) var(--s-5)", alignItems: "center", marginTop: "var(--s-4)", fontSize: "var(--fs-4)" }}>
            {insights.length === 0 && <span style={{ gridColumn: "1 / -1", fontSize: "var(--fs-3)", color: "var(--muted)" }}>{t("No counter readings from the account.", "Brak odczytów liczników z konta.")}</span>}
            {insights.map((item) => {
              const value = item.current.usedPercent;
              const estimated = item.current.percentBasis !== "measured" && value != null;
              const reset = item.current.resetIso ? Date.parse(item.current.resetIso) : NaN;
              return [
                <b key={`${item.counterKey}-n`} style={{ paddingLeft: item.isSublimit ? 8 : 0, whiteSpace: "nowrap" }}
                  title={item.isSublimit ? t("Sub-limit of the 7d window with its own denominator; it does not add up with 7d", "Podlimit okna 7d z własnym mianownikiem; nie sumuje się z 7d") : undefined}>{counterName(item)}</b>,
                <div key={`${item.counterKey}-b`} style={{ marginTop: -8 }}><Track fill={value} tick={item.current.isCurrent && !item.isSublimit ? item.current.elapsedPercent : null} height={8} /></div>,
                <span key={`${item.counterKey}-v`} style={{ textAlign: "right", whiteSpace: "nowrap", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)" }}>{estimated ? "≈" : ""}{pct(value)}
                  {estimated && <> <EstimateTag title={t("Percentage computed from local traffic and current calibration. It is not a vendor limit reading.", "Procent wyliczony z lokalnego ruchu i bieżącej kalibracji. Nie jest odczytem limitu vendora.")}>{t("estimate", "szacunek")}</EstimateTag></>}</span>,
                <span key={`${item.counterKey}-r`} style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {!item.current.isCurrent ? t("closed", "zamknięte") : item.isSublimit ? t("as 7d", "jak 7d")
                    : Number.isFinite(reset) ? `⟳ ${duration(Math.max(0, reset - Date.now()) / 3_600_000)}` : t("no reset", "brak resetu")}</span>,
              ];
            })}
            {otherMeters.map((meter) => {
              const reset = meter.resets_at ? Date.parse(meter.resets_at) : NaN;
              const dollars = meter.limit_dollars != null;
              return [
                <b key={`${meter.key}-n`} title={`${meter.key} · ${t("meaning unconfirmed", "znaczenie niepotwierdzone")}`}>{dollars ? t("$ limit", "Limit $") : t("Meter", "Licznik")}</b>,
                <div key={`${meter.key}-b`} style={{ marginTop: -8 }}><Track fill={meter.utilization_percent} height={8} /></div>,
                <span key={`${meter.key}-v`} style={{ textAlign: "right", whiteSpace: "nowrap", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)" }}>
                  {dollars ? `${money(meter.used_dollars)} / ${money(meter.limit_dollars)}` : pct(meter.utilization_percent)}</span>,
                <span key={`${meter.key}-r`} style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {Number.isFinite(reset) ? `⟳ ${duration(Math.max(0, reset - Date.now()) / 3_600_000)}` : t("no reset", "brak resetu")}</span>,
              ];
            })}
          </div>
          {shownMeters && otherMeters.length > 0 && <div className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)", marginTop: "var(--s-3)", lineHeight: 1.5 }}>
            {otherMeters.map((m) => m.key).join(", ")} · {t("meaning unconfirmed", "znaczenie niepotwierdzone")} · {t("read", "odczyt")} {dayTime(shownMeters.read_at)}
          </div>}
          {shownMeters?.extra_usage && (() => {
            const extra = shownMeters.extra_usage;
            const spent = extra.spent_minor == null ? null : extra.spent_minor / 10 ** (extra.exponent ?? 2);
            return <div className="mono" style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap", marginTop: "var(--s-4)", fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              <b style={{ color: "var(--text)" }} title="extra_usage">{t("Extra usage", "Dodatkowe zużycie")}</b>
              <Pill tone={extra.enabled ? "warn" : "neutral"}>{extra.enabled ? t("enabled", "włączone") : t("disabled", "wyłączone")}</Pill>
              <span>{t("spent", "wydano")} {spent == null ? "—" : `${spent.toLocaleString(locale, { minimumFractionDigits: 2 })} ${extra.currency ?? ""}`}
                {extra.user_disabled ? ` · ${t("turned off by the user", "wyłączone przez użytkownika")}` : ""}</span>
            </div>;
          })()}
        </div>

        <div>
          <Eyebrow>{t("This window", "To okno")} · {t("local index", "lokalny indeks")}</Eyebrow>
          <StatRow label={t("tokens", "tokeny")} value={compact(cur.spend.gross)}>
            <Stack parts={[{ value: cached, color: ACCENT_SOFT }, { value: cur.spend.fresh, color: "var(--accent)" }]} />
            <div style={mini}><span>cache {pct(cur.spend.gross > 0 ? (cached / cur.spend.gross) * 100 : null)}</span><span>{compact(cur.spend.fresh)}</span></div>
          </StatRow>
          <StatRow label={t("per day", "na dzień")} value={cur.elapsed_hours > 0 ? compact((cur.spend.gross / cur.elapsed_hours) * 24) : "—"} />
          <MachineRow shares={weekly?.current.trafficByMachine ?? []} />
          <StatRow label={t("calls", "wywołania")} value={full(cur.spend.calls)} />
          <StatRow label={<span title={poolFundingTitle()}>API-eq</span>} value={missingRate.tokens > 0 && !(cur.spend.usd > 0)
            ? <span style={{ color: "var(--warn)" }} title={missingRateAmountTitle(missingRate.models)}>{t("no price", "brak ceny")}</span>
            : `${unpriced > 0 ? "≥ " : ""}${usd(cur.spend.usd)}`}>
            {missingRate.tokens > 0 && <div data-missing-rate style={{ fontSize: "var(--fs-2)", color: "var(--warn)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={missingRateAmountTitle(missingRate.models)}>{missingRateNote(missingRate.models)}</div>}
            {unpriced > 0 && <span style={{ fontSize: "var(--fs-2)", color: "var(--warn)" }}
              title={t("These calls use a model without a catalog rate, so the amount is a lower bound.", "Te wywołania używają modelu bez stawki w cenniku, więc kwota jest dolną granicą.")}>
              {full(unpriced)} {t("unpriced calls", "wywołań bez ceny")}</span>}
          </StatRow>
          {accountCredit?.kind === "usd" && <StatRow label={t("call funding", "finansowanie wywołań")}
            value={grant
              ? <span title={`${full(grant.calls)} ${t(grant.calls === 1 ? "call" : "calls", polishPlural(grant.calls, "wywołanie", "wywołania", "wywołań"))} · ${dayTime(grant.first)} → ${dayTime(grant.last)}\n${poolFundingTitle()}`}>
                {poolLabel({ kind: "grant", unit: "usd" })} {grant.api_unpriced > 0 ? "≥ " : "≈ "}{usd(grant.api_standard)}</span>
              : <span title={poolFundingTitle()}>{t("not established", "nieustalone")}</span>} />}
          <WindowCreditsSection rows={windowCreditRows({ funded: null, windowTokens: null, pools: creditPools, account: accountCredit })} />
        </div>
      </>}
    />
  );
}
