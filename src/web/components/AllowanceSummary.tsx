import { useEffect, useId, useMemo, useState } from "react";
import type { AllowanceCandidate, AllowanceModelGroup, AllowanceMonth, AllowancePartial, AllowanceRatio, AllowanceSide, AllowanceStats, AllowanceUnit } from "../../shared/allowance-summary";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { capacityUnitFormat } from "../lib/codex-capacity";
import { providerName } from "../lib/capacity-compare";
import { vendorColor, vendorShade } from "../lib/model-colors";
import { barPath, niceStep } from "../lib/bar-chart";
import { ALLOWANCE_RANGES, allowanceDefaults, allowanceRange, cyclesText, monthLabel, ratioText, ratioTone, readAllowanceChoice, writeAllowanceChoice,
  type AllowanceChoice, type AllowanceRange } from "../lib/allowance-summary-view";
import { ChartExport } from "./ChartExport";
import { capacityUnitLabel } from "./CapacityCycleList";
import { Card, EmptyState, ErrorState, Field, HelpBlock, HelpDot, Pill, Selector, Tabs } from "./ui";
import { Kpi, KpiRow, useWidth } from "./WindowStatusCard";
import "./GlobalCapacity.css";
import "./ModelUnitCost.css";
import "./AllowanceSummary.css";

type T = (en: string, pl: string, values?: Array<string | number>) => string;
interface SideView { side: AllowanceSide; name: string; color: string }

/**
 * Value → Summary (UR-014 REQ-061): what one weekly allowance buys, month by month, for one subscription or two side by
 * side on one scale, with the latest well-sampled ratio as the headline. Everything comes from `/api/allowance-summary`.
 */
export function AllowanceSummary({ dataRevision }: { dataRevision?: number }) {
  const { t, locale } = useI18n();
  const [choice, setChoice] = useState<AllowanceChoice>(() => readAllowanceChoice());
  const choose = (next: Partial<AllowanceChoice>) => setChoice(current => { const merged = { ...current, ...next }; writeAllowanceChoice(merged); return merged; });
  const listed = useAsync(signal => api.allowanceCandidates(signal), [dataRevision], true);
  const candidates = listed.data?.candidates ?? [];
  const { a, b } = useMemo(() => allowanceDefaults(candidates, choice), [candidates, choice]);
  const { since, until } = allowanceRange(choice.months);
  const sideA = candidates.find(candidate => candidate.account === a), sideB = candidates.find(candidate => candidate.account === b);
  const read = useAsync(signal => a ? api.allowanceSummary({ a, a_counter: sideA?.counter, ...(b ? { b, b_counter: sideB?.counter } : {}), since, until,
    unit: choice.unit }, signal) : Promise.resolve(null), [a, b, sideA?.counter, sideB?.counter, since, until, choice.unit, dataRevision], true);
  const body = read.data;
  const format = capacityUnitFormat(choice.unit, locale);
  const sides: SideView[] = (body?.sides ?? []).map((side, index, all) => {
    const candidate = candidates.find(item => item.account === side.account);
    const base = vendorColor(side.provider) ?? "var(--accent)";
    // Two subscriptions of one provider keep its hue but not one shade.
    const color = index === 1 && all[0]?.provider === side.provider ? vendorShade(base, 2) : base;
    return { side, name: sideName(candidate, side), color };
  });
  const options = candidates.map(candidate => ({ value: candidate.account, label: `${sideName(candidate)} · ${candidate.account}` }));

  return <section className="global-capacity allowance-summary"><Card pad="0" style={{ overflow: "hidden" }}>
    <div className="ui-toolbar global-capacity-controls">
      <Field label={t("Subscription", "Subskrypcja")}><Selector ariaLabel={t("Subscription", "Subskrypcja")} value={a ?? ""} onChange={value => choose({ a: value })}
        options={options.length ? options : [{ value: "", label: t("No subscription", "Brak subskrypcji") }]} /></Field>
      <Field label={t("Compare with", "Porównaj z")}><Selector ariaLabel={t("Compare with", "Porównaj z")} value={b ?? ""} onChange={value => choose({ b: value })}
        options={[{ value: "", label: t("none", "brak") }, ...options.filter(option => option.value !== a)]} /></Field>
      <Field label={t("Range", "Zakres")}><Tabs value={String(choice.months)} onChange={value => choose({ months: Number(value) as AllowanceRange })}
        options={ALLOWANCE_RANGES.map(months => ({ value: String(months), label: t("{0} mo", `${months} mies.`, [months]) }))} /></Field>
      <Field label={t("Unit", "Jednostka")}><Tabs value={choice.unit} onChange={unit => choose({ unit: unit as AllowanceUnit })}
        options={(["api_standard", "tokens"] as const).map(value => ({ value, label: capacityUnitLabel(value, t) }))} /></Field>
    </div>
    {listed.error ? <div className="global-capacity-body"><ErrorState message={listed.error} onRetry={listed.reload} /></div>
      : !listed.data ? <p role="status" className="global-capacity-status">{t("Loading subscriptions…", "Wczytywanie subskrypcji…")}</p>
      : !a ? <div className="global-capacity-body"><EmptyState title={t("No subscription with a weekly limit", "Brak subskrypcji z limitem tygodniowym")}
          detail={t("The summary compares weekly allowances, from reset to reset.", "Podsumowanie porównuje limity tygodniowe, od resetu do resetu.")} /></div>
      : read.error ? <div className="global-capacity-body"><ErrorState message={read.error} onRetry={read.reload} /></div>
      : !body ? <p role="status" className="global-capacity-status">{t("Loading cycles…", "Wczytywanie cykli…")}</p>
      : <SummaryBody sides={sides} ratios={body.ratios} headline={body.headline} unit={choice.unit} format={format} counterLabel={sides[0]?.side.counter_label ?? ""}
          since={since} until={until} t={t} locale={locale} />}
  </Card></section>;
}

function sideName(candidate: AllowanceCandidate | undefined, side?: AllowanceSide): string {
  const provider = providerName(candidate?.provider ?? side?.provider ?? "");
  const plan = candidate?.plan_label ?? candidate?.plan;
  return plan ? `${provider} ${plan}` : provider || (side?.account ?? "");
}

function SummaryBody({ sides, ratios, headline, unit, format, counterLabel, since, until, t, locale }: {
  sides: SideView[]; ratios: AllowanceRatio[]; headline: AllowanceRatio | null; unit: AllowanceUnit; format: ReturnType<typeof capacityUnitFormat>;
  counterLabel: string; since: string; until: string; t: T; locale: string;
}) {
  const statsOf = (month: AllowanceMonth) => month[unit];
  const latest = (view: SideView) => [...(view.side.summary?.months ?? [])].reverse().find(month => statsOf(month).median !== null) ?? null;
  const amount = (stats: AllowanceStats | null, prefix = "") => stats?.median == null ? null : `${prefix}${stats.lower_bound ? "≥ " : ""}${format.full(stats.median)}`;
  const missing = (view: SideView) => view.side.state === "preparing" ? t("preparing", "w przygotowaniu")
    : view.side.state === "error" ? t("unavailable: {0}", `niedostępne: ${view.side.error ?? ""}`, [view.side.error ?? ""])
    : t("no measured week", "brak zmierzonego tygodnia");
  const updating = sides.some(view => view.side.state === "updating");
  const valued = (view: SideView, which: AllowanceUnit) => !!view.side.summary
    && (view.side.summary.months.some(month => month[which].median !== null) || view.side.summary.partial?.[which] != null);
  // A month that holds tokens only draws nothing in dollars: chart and export follow the chosen unit.
  const charted = sides.some(view => valued(view, unit)), measured = sides.some(view => valued(view, "tokens") || valued(view, "api_standard"));
  const excluded = sides.flatMap(view => Object.entries(view.side.summary?.excluded ?? {}).map(([reason, count]) => `${view.name}: ${reason.replace(/_/g, " ")} ${count}`));
  const notes = sides.flatMap(view => {
    const note = view.side.summary?.notes;
    return note && (note.uncertain_end || note.manual) ? [`${view.name}: ${t("uncertain end {0} · manual {1}", `niepewny koniec ${note.uncertain_end} · ręczne ${note.manual}`, [note.uncertain_end, note.manual])}`] : [];
  });
  const counter = counterLabel ? t("{0} limit · reset to reset", `Limit ${counterLabel === "Weekly" ? "tygodniowy" : counterLabel} · od resetu do resetu`, [counterLabel]) : null;
  return <>
    {updating && <p role="status" className="global-capacity-status">{t("Updating: the last published cycles are shown.", "Trwa aktualizacja: pokazane są ostatnio opublikowane cykle.")}</p>}
    <div className="allowance-head">
      {counter && <Pill tone="accent">{counter}</Pill>}
      <HelpDot label={t("What one allowance is", "Czym jest jeden limit")}>
        <HelpBlock>{t("One allowance is the cycle's value at 100% of the weekly meter, the same estimate as Limits → Capacity: recorded traffic ÷ meter increase × 100, or the provider's prepared share sample where one exists; API value as the Capacity screen counts it.",
          "Jeden limit to wartość cyklu przy 100% licznika tygodniowego, ten sam szacunek co w Limity → Pojemność: zapisany ruch ÷ przyrost licznika × 100 albo przygotowana próbka udziału dostawcy, jeśli istnieje; wartość API liczona tak jak na ekranie Pojemność.")}</HelpBlock>
        <HelpBlock>{t("Each month is the median of your own closed cycles that started in it and used at least 40% of the meter. The current cycle is drawn apart and never enters a median. ≥ marks a lower bound (some traffic has no price); a ratio over one lower bound is ≤ or ≥, over two it is ≈. Estimates, not vendor figures.",
          "Każdy miesiąc to mediana Twoich zamkniętych cykli, które się w nim zaczęły i zużyły co najmniej 40% licznika. Bieżący cykl jest rysowany osobno i nie wchodzi do mediany. ≥ oznacza dolną granicę (część ruchu nie ma ceny); iloraz z jedną dolną granicą to ≤ lub ≥, z dwiema ≈. Szacunki, nie dane dostawcy.")}</HelpBlock>
        {(excluded.length > 0 || notes.length > 0) && <HelpBlock>{[...excluded, ...notes].join(" · ")}</HelpBlock>}
      </HelpDot>
    </div>
    <KpiRow columns={sides.length > 1 && headline ? 3 : sides.length || 1}>
      {sides.length > 1 && headline && <Kpi label={`${sides[1]!.name} ÷ ${sides[0]!.name} · ${monthLabel(headline.month, locale)}`}
        value={ratioText(headline, locale)} color={ratioTone(headline)} visual={null}
        caption={t("at least {0} a side", `co najmniej ${cyclesText(headline.min_n, t)} na stronę`, [cyclesText(headline.min_n, t)])} />}
      {sides.map(view => {
        const month = latest(view);
        return <Kpi key={view.side.account} label={view.name} visual={null}
          value={month ? amount(statsOf(month)) : <span className="ui-missing">{missing(view)}</span>}
          caption={month ? `${monthLabel(month.month, locale)} · ${cyclesText(statsOf(month).n, t)}` : view.side.account} />;
      })}
    </KpiRow>
    <div className="global-capacity-body">
      <ChartExport title={t("What one allowance buys", "Co kupuje jeden limit")} available={charted}>
        <section className="models-chart" aria-label={t("What one allowance buys", "Co kupuje jeden limit")}>
          <div className="archive-head">
            <div><b>{t("What one allowance buys", "Co kupuje jeden limit")}</b> <span className="archive-sub">· {capacityUnitLabel(unit, t)} · {t("median per month", "mediana miesiąca")} · {since} – {until} UTC</span></div>
            <div className="archive-legend">{sides.map(view => <span key={view.side.account}><i className="allowance-swatch" style={{ background: view.color }} />{view.name}</span>)}</div>
          </div>
          {charted ? <MonthsChart sides={sides} ratios={ratios} unit={unit} format={format} t={t} locale={locale} />
            : measured && unit === "api_standard" ? <EmptyState title={t("No priced week in this range", "Brak wycenionego tygodnia w tym zakresie")}
              detail={t("These weeks have tokens but no API price; switch to Tokens to compare them.", "Te tygodnie mają tokeny, ale bez ceny API; przełącz na Tokeny, aby je porównać.")} />
            : <EmptyState title={t("No measured week in this range", "Brak zmierzonego tygodnia w tym zakresie")}
              detail={t("A week counts from 40% of the meter used.", "Tydzień liczy się od 40% zużytego licznika.")} />}
        </section>
      </ChartExport>
      <ModelsCard sides={sides} since={since} until={until} t={t} locale={locale} />
    </div>
  </>;
}

/**
 * Card C (REQ-062): one allowance in tokens by the model that carried at least 70% of a week's API Standard value, so
 * the model, not only the plan, shows how many tokens an allowance buys. Groups of one cycle are left out.
 */
function ModelsCard({ sides, since, until, t, locale }: { sides: SideView[]; since: string; until: string; t: T; locale: string }) {
  const tokens = capacityUnitFormat("tokens", locale), dollars = capacityUnitFormat("api_standard", locale);
  const groups = sides.flatMap(view => (view.side.summary?.models ?? []).map(group => ({ view, group })));
  const rows = groups.filter(({ group }) => !group.thin);
  const thin = groups.length - rows.length;
  const excluded = sides.reduce((sum, view) => sum + Object.values(view.side.summary?.dominance_excluded ?? {}).reduce((total, n) => total + (n ?? 0), 0), 0);
  const peak = Math.max(1, ...rows.map(({ group }) => group.tokens.median ?? 0));
  const per = (group: AllowanceModelGroup) => {
    const usd = group.api_standard.median, perM = group.usd_per_million;
    const missing = <span className="ui-missing">{t("no price", "brak ceny")}</span>;
    const bound = group.lower_bound ? "≥ " : "";
    return <>{usd === null ? missing : `${bound}${dollars.full(usd)}`} · {perM === null ? missing : `$${perM.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`}</>;
  };
  return <ChartExport title={t("One allowance in tokens", "Jeden limit w tokenach")} available={rows.length > 0}>
    <section className="models-chart allowance-models" aria-label={t("One allowance in tokens by model", "Jeden limit w tokenach według modelu")}>
      <div className="archive-head">
        <div><b>{t("One allowance in tokens: the model decides", "Jeden limit w tokenach: decyduje model")}</b> <span className="archive-sub">· {since} – {until} UTC · {t("≥ 70% of value", "≥ 70% wartości")}</span>{" "}
          <span data-capture-exclude=""><HelpDot label={t("Tokens per allowance by model", "Tokeny na limit według modelu")}>
            <HelpBlock>{t("Weeks where one model carried at least 70% of the API Standard value, grouped by that model: the median tokens and dollars one allowance bought, and the API value per 1M tokens of those weeks (their total value ÷ their priced tokens).",
              "Tygodnie, w których jeden model dał co najmniej 70% wartości Standard API, pogrupowane według tego modelu: mediana tokenów i dolarów, jakie kupił jeden limit, oraz wartość API na 1M tokenów tych tygodni (ich łączna wartość ÷ wycenione tokeny).")}</HelpBlock>
            <HelpBlock>{t("≥ marks a lower bound: some of those weeks' traffic has no price, so their model was told from the priced part.",
              "≥ oznacza dolną granicę: część ruchu tych tygodni nie ma ceny, więc model ustalono z wycenionej części.")}</HelpBlock>
            {(thin > 0 || excluded > 0) && <HelpBlock>{[
              thin > 0 ? t("{0} groups with one cycle left out", `pominięte grupy z jednym cyklem: ${thin}`, [thin]) : null,
              excluded > 0 ? t("{0} weeks without one model at 70% or without a model split", `tygodnie bez modelu z 70% albo bez podziału na modele: ${excluded}`, [excluded]) : null,
            ].filter(Boolean).join(" · ")}</HelpBlock>}
          </HelpDot></span></div>
      </div>
      {!groups.length ? <EmptyState title={t("No week with one model at 70% of its value", "Brak tygodnia, w którym jeden model dał 70% wartości")} />
        : !rows.length ? <EmptyState title={t("Only single-cycle groups", "Tylko grupy z jednym cyklem")}
          detail={t("A model shows once it carried two weeks.", "Model pojawi się, gdy przeważy w dwóch tygodniach.")} />
        : <div className="allowance-model-rows">
          <div className="allowance-model-row is-head"><span /><span>{t("tokens per allowance", "tokeny na limit")}</span><span>{t("$ per allowance · $ per 1M", "$ na limit · $ za 1M")}</span></div>
          {rows.map(({ view, group }) => <div className="allowance-model-row" key={`${view.side.account}:${group.model}`}>
            <div className="allowance-model-name"><b>{view.name}</b>
              <span>{t("mostly {0} · {1}", `głównie ${group.model} · ${cyclesText(group.n, t)}`, [group.model, cyclesText(group.n, t)])}</span></div>
            <div className="allowance-model-bar">
              <i style={{ width: `calc((100% - 84px) * ${(group.tokens.median ?? 0) / peak})`, backgroundColor: view.color }} />
              <b className="mono">{group.tokens.median === null ? "" : tokens.full(group.tokens.median)}</b>
            </div>
            <div className="mono allowance-model-dollars">{per(group)}</div>
          </div>)}
        </div>}
    </section>
  </ChartExport>;
}

interface Bar { view: SideView; value: number; stats?: AllowanceStats; partial?: AllowancePartial; plans?: string[] }
interface Group { key: string; label: string; sub: string | null; ratio: AllowanceRatio | null; bars: Array<Bar | null> }

function MonthsChart({ sides, ratios, unit, format, t, locale }: {
  sides: SideView[]; ratios: AllowanceRatio[]; unit: AllowanceUnit; format: ReturnType<typeof capacityUnitFormat>; t: T; locale: string;
}) {
  const [ref, width] = useWidth(900);
  const hatchId = `allowance-hatch-${useId().replace(/:/g, "")}`;
  const monthKeys = [...new Set(sides.flatMap(view => view.side.summary?.months.filter(month => month[unit].median !== null).map(month => month.month) ?? []))].sort();
  const years = new Set(monthKeys.map(key => key.slice(0, 4)));
  const groups: Group[] = monthKeys.map(key => ({ key, label: monthLabel(key, locale, years.size > 1), sub: null,
    ratio: ratios.find(ratio => ratio.month === key) ?? null,
    bars: sides.map(view => {
      const month = view.side.summary?.months.find(item => item.month === key), stats = month?.[unit];
      return stats?.median != null ? { view, value: stats.median, stats, plans: month!.plans } : null;
    }) }));
  const partials = sides.map(view => {
    const partial = view.side.summary?.partial, value = partial?.[unit];
    return partial && value != null ? { view, value, partial } : null;
  });
  if (partials.some(Boolean)) groups.push({ key: "now", label: t("Now", "Teraz"), sub: t("partial cycle", "niepełny cykl"), ratio: null, bars: partials });
  const LEFT = 56, RIGHT = 8, TOP = 62, PLOT = 240, AXIS = 40;
  const bottom = TOP + PLOT, height = bottom + AXIS;
  const peak = Math.max(1, ...groups.flatMap(group => group.bars.map(bar => bar?.value ?? 0)));
  const step = niceStep(peak * 1.12, 4), max = Math.ceil(peak * 1.12 / step) * step;
  const y = (value: number) => bottom - value / max * PLOT;
  const slot = (width - LEFT - RIGHT) / Math.max(1, groups.length);
  // Wide enough gaps that the labels under neighbouring bars ("7 cycles", "first 55%") never touch.
  const bar = Math.min(56, slot / (sides.length + 1.6)), gap = Math.min(24, Math.max(12, slot * 0.08));
  // Narrow bars (six months and more) keep short labels; the tooltip still says everything.
  const narrow = bar + gap < 64;
  const valueText = (value: number) => narrow && unit === "api_standard" && value >= 1000
    ? `$${(value / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })}k` : format.full(value);
  return <div ref={ref}>
    <svg className="muc-svg" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={t("What one allowance buys by month", "Co kupuje jeden limit według miesięcy")}>
      <defs><pattern id={hatchId} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1={0} y1={0} x2={0} y2={7} stroke="var(--hatch)" strokeWidth={1.2} />
      </pattern></defs>
      {Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step).map(value => <g key={value}>
        {value > 0 && <line className="muc-grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} />}
        <text className="muc-tick" x={LEFT - 10} y={y(value) + 4} textAnchor="end">{format.full(value)}</text>
      </g>)}
      <line x1={LEFT} x2={width - RIGHT} y1={bottom + 0.5} y2={bottom + 0.5} stroke="var(--line2)" />
      {groups.map((group, index) => {
        const center = LEFT + slot * (index + 0.5), count = group.bars.length, first = center - (count * bar + (count - 1) * gap) / 2;
        return <g key={group.key}>
          <text className="allowance-month" x={center} y={16} textAnchor="middle">{group.label}</text>
          {group.sub && <text className="muc-tick" x={center} y={32} textAnchor="middle">{group.sub}</text>}
          {group.ratio?.ratio != null && <text className="allowance-ratio" x={center} y={36} textAnchor="middle" style={{ fill: ratioTone(group.ratio) }}>
            {slot >= 220 ? `${sides[1]?.name ?? "B"} ÷ ${sides[0]?.name ?? "A"} ${ratioText(group.ratio, locale)}` : ratioText(group.ratio, locale)}</text>}
          {group.bars.map((item, slotIndex) => {
            if (!item) return null;
            const x = first + slotIndex * (bar + gap), top = y(item.value), path = barPath(x, top, bar, bottom);
            const partial = item.partial, n = item.stats?.n ?? 0;
            const bound = partial ? unit === "api_standard" && partial.lower_bound : item.stats?.lower_bound;
            const prefix = `${partial ? "~" : ""}${bound ? "≥ " : ""}`;
            const title = partial
              ? `${item.view.name} · ${t("current cycle, {0}% of the meter so far", `bieżący cykl, dotąd ${Math.round(partial.observed_pp)}% licznika`, [Math.round(partial.observed_pp)])}`
              : `${item.view.name} · ${t("median of {0}", `mediana: ${cyclesText(n, t)}`, [cyclesText(n, t)])} · ${format.full(item.stats!.min!)} – ${format.full(item.stats!.max!)}${item.plans && item.plans.length > 1 ? ` · ${item.plans.join(" → ")}` : ""}`;
            return <g key={item.view.side.account}>
              <title>{title}</title>
              {partial
                ? <path d={path} className="allowance-partial" style={{ stroke: item.view.color, fill: `color-mix(in oklab, ${item.view.color} 16%, transparent)` }} />
                : <><path d={path} style={{ fill: item.view.color }} /><path d={path} fill={`url(#${hatchId})`} /></>}
              <text className="muc-value" x={x + bar / 2} y={top - 7} textAnchor="middle">{`${prefix}${valueText(item.value)}`}</text>
              <text className={`muc-tick${!partial && n < 2 ? " allowance-thin" : ""}`} x={x + bar / 2} y={bottom + 17} textAnchor="middle">
                {partial ? narrow ? `${Math.round(partial.observed_pp)}%` : t("first {0}%", `pierwsze ${Math.round(partial.observed_pp)}%`, [Math.round(partial.observed_pp)])
                  : narrow ? `n ${n}` : cyclesText(n, t)}</text>
              {!partial && !narrow && item.plans && item.plans.length > 1 && <text className="muc-tick allowance-thin" x={x + bar / 2} y={bottom + 31} textAnchor="middle">
                {t("plan changed", "zmiana planu")}</text>}
            </g>;
          })}
        </g>;
      })}
    </svg>
  </div>;
}
