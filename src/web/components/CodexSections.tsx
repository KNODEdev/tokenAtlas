import { useMemo, useState } from "react";
import type { ScreenProps } from "../lib/screens";
import { useBreakpoint, splitColumns } from "../lib/useBreakpoint";
import { api, type CycleBreakdownResponse, type UsageSeries } from "../lib/api";
import { useContextPreview } from "../lib/context-premium";
import { breakdownWithContextPreview } from "../lib/window-context-preview";
import { useAsync } from "../lib/useAsync";
import { historicalWindowCaps, previousCapWindows } from "../lib/window-caps";
import { CodexWindowStats } from "./CodexWindowStats";
import { WindowStatusCard } from "./WindowStatusCard";
import { accountCreditsOfCycles } from "../lib/credit-pools-view";
import { buildWindowInsights } from "../lib/window-insights";
import { railWindowsFromCycles } from "../lib/windows";
import { comparableStatWindows, cyclePlanDescription, cyclePlanLabel, historyThroughCycle, modelThroughCycle, withWindowTraffic, observationOf, observedRates, usageAtSameTime, windowForecast, trafficRangeOf, windowRates, windowTrafficSummary, medianDailyTraffic } from "../lib/codex-window-stats";
import { CycleBreakdown } from "../components/CycleBreakdown";
import { CycleMilestones, TokenComposition } from "../components/CycleComposition";
import { BudgetCard, PaceCard, VersusCard, percentUnit, type BudgetUnit } from "./WindowForecastPanel";
import { sumWindowTokens } from "../lib/window-tokens";
import { CodexModelsHelp, CodexWindowModels, codexModelCount } from "./CodexWindowModels";
import { CycleRail } from "../components/CycleRail";
import { CycleHistoryTable, FullHistoryLink } from "./CycleHistoryTable";
import { AllowanceValue } from "../components/AllowanceValue";
import {
  Card,
  CardTitle,
  EstimateTag,
  Eyebrow,
} from "../components/ui";
import { compact, dayTime, signedPct, signedPp, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { MissingSection, missingVendorSections, type VendorOverviewSections } from "./VendorOverview";
import { WindowProjects } from "./WindowProjects";
import { OverviewProjectSelector } from "./OverviewProjectSelector";
import { ALL_WINDOW_PROJECTS } from "../lib/window-projects";

function localizedNumber(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString(getLocale(), { maximumFractionDigits });
}

function ownershipReasonLabel(reason: string): string {
  switch (reason) {
    case "verified-account-window-conflict":
      return translate("counter belongs to another verified account", "licznik odpowiada innemu potwierdzonemu kontu");
    case "source-not-declared":
      return translate("source not declared", "źródło bez deklaracji");
    case "outside-declared-era":
      return translate("outside declared eras", "poza zadeklarowanymi erami");
    case "ambiguous-era":
      return translate("overlapping eras", "nakładające się ery");
    case "source-missing":
      return translate("source missing", "brak źródła");
    case "timestamp-missing":
      return translate("sample timestamp missing", "brak czasu próbki");
    case "ownership-index-missing":
      return translate("ownership index does not cover the sample", "indeks przypisania nie obejmuje próbki");
    case "ownership-index-unavailable":
      return translate("ownership index unavailable", "indeks przypisania jest niedostępny");
    default:
      return reason;
  }
}
export function ownershipGapText(ownership: UsageSeries["ownership"]): string | null {
  if (ownership.unowned_samples <= 0) return null;
  const reasons = ownership.reasons
    .map((row) => `${ownershipReasonLabel(row.reason)}: ${localizedNumber(row.samples)}`)
    .join(" · ");
  return translate(
    "Unassigned: {0} samples. Reason: {1}. These samples are excluded from charts and totals.",
    `Brak przypisania: ${localizedNumber(ownership.unowned_samples)} próbek. Powód: ${reasons}. Te próbki nie wchodzą do wykresów ani kwot.`, [localizedNumber(ownership.unowned_samples), reasons]
  );
}
export function liveWindowApiCost(data: Pick<CycleBreakdownResponse, "totals" | "unpriced"> | null): number | null {
  if (!data || data.totals.calls <= 0 || !Number.isFinite(data.totals.usd)) return null;
  // A zero total with unpriced tokens is missing pricing, not a free API call.
  if (data.totals.usd === 0 && data.unpriced.tokens > 0) return null;
  return data.totals.usd;
}
export function costPerUsedPercent(total: number | null | undefined, usedPercent: number): number | null {
  if (total == null || !Number.isFinite(total) || total < 0 || !Number.isFinite(usedPercent) || usedPercent <= 0) return null;
  return total / usedPercent;
}
export function useCodexSections(props: ScreenProps): VendorOverviewSections {
  const contextPreview = useContextPreview();
  const { model, openDrawer, selectCycle, account, card, project, windowRailInShell, chosen, goto } = props;
  const [allProjects, setAllProjects] = useState(false);
  const { t } = useI18n();
  const bp = useBreakpoint();
  const selectedCycle = chosen ?? model.current;
  const ownershipGap = ownershipGapText(model.series.ownership);
  const hasIndexedTelemetry = selectedCycle != null && selectedCycle.raw.sample_count > 0;
  const range = selectedCycle ? trafficRangeOf(selectedCycle) : null;
  const from = range?.from ?? null;
  const to = range?.until ?? null;
  const anchor = hasIndexedTelemetry ? selectedCycle?.raw.anchor ?? undefined : undefined;
  const limitId = selectedCycle?.raw.limit_id ?? model.series.limit_id;
  const breakdownKey = JSON.stringify([account, from, to, anchor, limitId]);
  const breakdownRequest = useAsync<{ key: string; value: CycleBreakdownResponse | null }>(
    async signal => ({
      key: breakdownKey,
      value: from && to ? await api.cycleBreakdown({ account, since_ts: from, until_ts: to, anchor, limit_id: limitId }, signal, true) : null,
    }),
    [account, from, to, anchor, limitId]
  );
  // useAsync keeps previous data while fetching; never price a different window.
  const breakdown = {
    ...breakdownRequest,
    data: breakdownWithContextPreview(!breakdownRequest.error && breakdownRequest.data?.key === breakdownKey ? breakdownRequest.data.value : null, contextPreview),
  };
  const modelKey = JSON.stringify([breakdownKey, project]);
  const projectModels = useAsync(async signal => ({ key: modelKey, value: project && from && to
    ? await api.cycleBreakdown({ account, since_ts: from, until_ts: to, anchor, limit_id: limitId, project_id: project }, signal, true) : null }), [modelKey]);
  const modelBreakdown = project ? { loading: projectModels.loading, error: projectModels.error,
    data: !projectModels.error && projectModels.data?.key === modelKey ? projectModels.data.value : null } : breakdown;
  const observation = selectedCycle ? observationOf(selectedCycle) : null;
  const pairedKey = JSON.stringify([account, limitId, anchor, observation?.from, observation?.until]);
  const paired = useAsync(async signal => ({
    key: pairedKey,
    data: observation?.from && observation.until ? await api.cycleBreakdown({
      account, limit_id: limitId, anchor, since_ts: observation.from, until_ts: observation.until, end_inclusive: true,
    }, signal, true) : null,
  }), [pairedKey]);
  const pairedData = breakdownWithContextPreview(!paired.error && paired.data?.key === pairedKey ? paired.data.data : null, contextPreview);
  const candidates = selectedCycle ? previousCapWindows(model.closed.filter(c => c.usedPercent >= 10
    && cyclePlanLabel(c) === cyclePlanLabel(selectedCycle)), selectedCycle) : [];
  const historySince = candidates.at(-1)?.startIso.slice(0, 10) ?? from?.slice(0, 10);
  const historyUntil = selectedCycle ? new Date(Math.min(Date.now(), Date.parse(selectedCycle.resetIso ?? selectedCycle.endIso))).toISOString().slice(0, 10) : null;
  const accountingKey = JSON.stringify([account, historySince, historyUntil]);
  const accounting = useAsync(async signal => ({
    key: accountingKey,
    data: selectedCycle?.windowHours === 168 && limitId === "codex" && historySince && historyUntil
      ? await api.codexAccounting({ account, since: historySince, until: historyUntil },signal) : null,
  }), [accountingKey, selectedCycle?.windowHours, limitId]);
  const accountingWindows = !accounting.error && accounting.data?.key === accountingKey ? accounting.data.data?.windows ?? [] : [];
  const historyWindows = selectedCycle ? comparableStatWindows(candidates, selectedCycle, accountingWindows) : [];
  const historyKey = JSON.stringify([account, historyWindows.map(c => [c.index, c.raw.limit_id, c.usedPercent, trafficRangeOf(c)])]);
  const history = useAsync(async signal => {
    signal.throwIfAborted();
    const load = async (c: typeof historyWindows[number]) => {
        const range = trafficRangeOf(c);
        const data = await api.cycleBreakdown({
          account, since_ts: range.from, until_ts: range.until, anchor: c.raw.anchor ?? undefined,
          limit_id: c.raw.limit_id ?? undefined,
        }, signal, true);
        return { index: c.index, usedPercent: c.usedPercent, data, rates: windowRates(c, data), dailyTraffic: windowTrafficSummary(c, data).perDay };
      };
    const samples: Awaited<ReturnType<typeof load>>[] = [];
    for (let offset = 0; offset < historyWindows.length; offset += 2) {
      signal.throwIfAborted();
      samples.push(...await Promise.all(historyWindows.slice(offset, offset + 2).map(load)));
    }
    return { key: historyKey, samples };
  }, [historyKey]);
  const historicalRaw = !history.error && history.data?.key === historyKey ? history.data : null;
  const historical = historicalRaw && { ...historicalRaw,
    caps: historicalWindowCaps(historicalRaw.samples.flatMap(sample => sample.data && sample.rates.comparable
      ? [{ usedPercent: sample.usedPercent, data: breakdownWithContextPreview(sample.data, contextPreview) }] : [])),
    samples: historicalRaw.samples.map(sample => {
      const data = breakdownWithContextPreview(sample.data, contextPreview);
      const cycle = historyWindows.find(window => window.index === sample.index);
      return { ...sample, data, rates: cycle ? windowRates(cycle, data) : sample.rates };
    }) };
  // Same counters and typical course the window rail reads, for the status block.
  const statusInsights = useMemo(() => buildWindowInsights(
    railWindowsFromCycles(model.cycles, model.series.points, model.series.activity ?? [], model.series.traffic ?? []),
    Date.now(), chosen ? String(chosen.index) : null,
  ), [model, chosen]);
  const historicalCaps = historical?.caps ?? null;
  const historyNote = history.error || accounting.error ? t("History read failed", "Odczyt historii nieudany")
    : history.loading || accounting.loading ? t("Reading historical windows…", "Odczyt historycznych okien…")
    : t("Observed comparison of up to 10 earlier windows of the same account, plan and counter, with at least 10% usage. Unknown promotion terms do not confirm equal contractual capacity. Only fully priced observations contribute to cost caps.",
      "Porównanie obserwacji z maksymalnie 10 wcześniejszych okien tego samego konta, planu i licznika, ze zużyciem co najmniej 10%. Nieznane promocje nie potwierdzają równej pojemności umownej. Do capów kosztowych wchodzą tylko obserwacje z pełną wyceną.");
  if (!selectedCycle) {
    const idle = card?.live != null && card.live.used_percent === 0;
    const missing = missingVendorSections(
      idle ? t("Account is idle - the window has not started yet", "Konto jest bezczynne — okno jeszcze się nie zaczęło") : t("No active cycle", "Brak aktywnego cyklu"),
      idle
        ? t("The account reports 0% usage, and the weekly window starts with the first call. There is no reset anchor or section data yet.", "Konto raportuje 0% zużycia, a okno tygodniowe liczy się dopiero od pierwszego wywołania — nie ma jeszcze kotwicy resetu ani danych sekcji.")
        : t("There is no active period between resets for the selected window and account. Change the account or window length, or sync the index.", "W wybranym oknie i koncie nie ma trwającego okresu między resetami. Zmień konto, długość okna albo zsynchronizuj indeks.")
    );
    if (!ownershipGap) return missing;
    const gap = <MissingSection title={t("Incomplete data ownership", "Niepełne przypisanie danych")} detail={ownershipGap} />;
    return {
      planWindows: <>{gap}{missing.planWindows}</>,
      models: <>{gap}{missing.models}</>,
      traffic: <>{gap}{missing.traffic}</>,
      provenance: <>{gap}{missing.provenance}</>,
      calibration: <>{gap}{missing.calibration}</>,
    };
  }
  const cur = withWindowTraffic(selectedCycle, breakdown.data);
  const planLabel = cyclePlanDescription(cur);
  const pricedHistory = historyWindows.map(c => withWindowTraffic(c, historical?.samples.find(s => s.index === c.index)?.data ?? null));
  const scopedModel = modelThroughCycle(model, cur, pricedHistory);
  const rates = observedRates(cur, pairedData);
  const averages = windowRates(cur, breakdown.data);
  const forecast = windowForecast(cur);
  const remainingTokens = rates.tokens !== null ? rates.tokens * Math.max(0, 100 - observationOf(cur).percent) : null;
  const sustainablePerDay = rates.tokens !== null && forecast.remainingPerHour !== null ? rates.tokens * forecast.remainingPerHour * 24 : null;
  const burnPerDay = pairedData && observation?.hours ? pairedData.totals.tokens / observation.hours * 24 : null;
  const indexedCost = liveWindowApiCost(breakdown.data);
  const credits = breakdown.data?.credit_equivalent;
  const partialApiCost = (breakdown.data?.unpriced.tokens ?? 0) > 0;
  const apiPerPercent = rates.api;
  const usdCeiling = apiPerPercent != null ? apiPerPercent * 100 : null;
  const observedTokenRate = rates.tokens;
  const observedTokenAllowance = observedTokenRate != null ? observedTokenRate * 100 : null;
  const creditsPerPercent = rates.credits;
  const projected = windowForecast(cur).projected;
  const median = scopedModel.median;
  const previous = historyWindows[0];
  const previousPercent = usageAtSameTime(previous, cur, model.series);
  const previousRates = historical?.samples.find(s => s.index === previous?.index)?.rates ?? null;
  const vsTypical: { key: string; label: string; delta: number; text: string; higherIsBetter: boolean }[] = [];
  if (previousPercent && (!cur.isActive || windowForecast(cur).fresh)) {
    const delta = observationOf(cur).percent - previousPercent.value;
    vsTypical.push({ key: "allowance-used", label: t("Limit at the same elapsed time", "Limit po takim samym czasie"),
      delta, text: (previousPercent.basis === "measured" ? "" : "≈ ") + signedPp(delta), higherIsBetter: false });
  }
  for (const [metric, label] of [["tokens", t("Tokens / pp", "Tokeny / p.p.")], ["api", t("API$ / pp", "API$ / p.p.")], ["credits", t("Credits / pp", "Kredyty / p.p.")]] as const) {
    const before = previousRates?.[metric], current = averages[metric];
    const partial = metric === "api" ? averages.apiPartial || previousRates?.apiPartial : metric === "credits" ? averages.creditsPartial || previousRates?.creditsPartial : false;
    if (averages.comparable && previousRates?.comparable && before != null && before > 0 && current != null) vsTypical.push({
      key: metric, label: label + (partial ? " · " + t("priced portion only", "tylko wyceniona część") : ""),
      delta: (current / before - 1) * 100, text: signedPct((current / before - 1) * 100), higherIsBetter: true,
    });
  }
  const insights = buildInsights(scopedModel);
  const chartPoints = cur.live
    ? [
        ...model.series.points,
        {
          ts: cur.live.ts,
          ts_last: cur.live.ts,
          cycle: cur.index,
          percent: cur.usedPercent,
          percent_min: cur.usedPercent,
          percent_last: cur.usedPercent,
          samples: 1,
          cycle_progress: cur.elapsedPercent,
        },
      ]
    : model.series.points;
  const recent = historyThroughCycle(model.cycles, cur).map(c => c.index === cur.index ? cur : pricedHistory.find(p => p.index === c.index) ?? c);
  const burnWindows = breakdown.data?.burn_windows ?? [];
  const shadow = cur.isActive ? card?.shadow ?? null : null;
  const railInHero = !windowRailInShell && bp === "desktop";
  // Ready once the current key has answered; a background refresh of the same key keeps the median visible.
  const historyReady = !accounting.error && historical !== null && (!accounting.loading || accounting.data !== null);
  const accountCredit = accountCreditsOfCycles(model.cycles, card?.pointBasis, card?.creditPools);
  const projectControl = <OverviewProjectSelector account={account} cycle={selectedCycle} value={allProjects ? ALL_WINDOW_PROJECTS : project} onChange={value => {
    setAllProjects(value === ALL_WINDOW_PROJECTS);
    props.setProject(value === ALL_WINDOW_PROJECTS ? "" : value);
  }} />;
  const lead = (
    <WindowStatusCard cycle={cur} insights={statusInsights} account={account}
      chartControl={projectControl}
      chartOverride={(allProjects || project) && from && to ? <WindowProjects account={account} from={from} until={to} project={allProjects ? ALL_WINDOW_PROJECTS : project} chartOnly usedPercent={limitId === "codex" ? observationOf(cur).percent : null} control={projectControl} /> : undefined}
      totals={breakdown.data} loading={breakdown.loading} error={breakdown.error}
      remainingTokens={remainingTokens}
      dailyMedian={historyReady ? medianDailyTraffic(historical?.samples.map(s => s.dailyTraffic) ?? []) : null}
      ownershipGap={ownershipGap ? { samples: model.series.ownership.unowned_samples, text: ownershipGap } : null}
      observations={insights} accountCredit={accountCredit} />
  );
  const burnRows = burnWindows.filter(w => w.hours > 0 && w.hours < cur.windowHours)
    .map(w => ({ label: w.label, perDay: w.tokens / w.hours * 24 }));
  const credit = credits?.value ?? (credits && credits.priced_credits > 0 ? credits.priced_credits : null);
  const budgetUnits: BudgetUnit[] = [
    percentUnit("%", observationOf(cur).percent),
    { key: "tokens", label: t("tokens", "tokeny"), rate: observedTokenRate, used: hasIndexedTelemetry ? cur.tokensTotal : null, partial: false,
      cap: historicalCaps?.tokens.value ?? null, format: (v) => compact(v) },
    { key: "api", label: "API-eq", rate: apiPerPercent, used: indexedCost, partial: partialApiCost || rates.apiPartial,
      cap: historicalCaps?.api.value ?? null, format: usd },
    ...(limitId === "codex" ? [{ key: "credits", label: t("credits", "kredyty"), rate: creditsPerPercent, used: credit,
      partial: !!credits?.unpriced_calls || rates.creditsPartial, cap: historicalCaps?.credits.value ?? null,
      format: (v: number) => localizedNumber(v) }] : []),
  ];
  const typicalEnd = cur.isActive ? statusInsights.find(i => i.current.windowKey === String(cur.index) && !i.isSublimit)?.forecastPercent ?? null : null;
  const planWindows = (
    <>
      <BudgetCard units={budgetUnits} usedPercent={observationOf(cur).percent} typicalEnd={typicalEnd} linearEnd={projected} active={cur.isActive}
          foot={observedTokenAllowance != null ? <span title={historyNote}>100% ≈ {compact(observedTokenAllowance)} {t("tokens", "tokenów")}
            {usdCeiling != null ? ` · ${partialApiCost ? "≥ " : "≈ "}${usd(usdCeiling)} API-eq` : ""}
            {" · "}{t("at this window's model mix", "przy obecnym miksie modeli")}</span> : t("No tokens-per-% calibration for this window yet.", "To okno nie ma jeszcze kalibracji tokenów na %.")} />
      <section style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "var(--s-8)" }}>
        <PaceCard burns={burnRows} sustainablePerDay={cur.isActive ? sustainablePerDay : null} averagePerDay={burnPerDay} active={cur.isActive} />
        <VersusCard
          title={previous ? `${t("vs", "vs")} ${previous.label} · ${t("at the same elapsed time", "w tym samym momencie okna")}` : t("Versus previous comparable window", "Względem poprzedniego porównywalnego okna")}
          rows={vsTypical}
          empty={history.error || accounting.error ? t("Comparison history read failed.", "Nie udało się odczytać historii porównań.")
            : history.loading || accounting.loading ? t("Loading comparison history…", "Odczyt historii porównań…")
            : previous ? t("Previous window found; matching meter readings or complete pricing are missing.", "Znaleziono poprzednie okno; brak odpowiadających odczytów licznika lub pełnej wyceny.")
            : t("No earlier non-overlapping window with the same plan and counter and at least 10% usage. Known conflicting promotion factors are excluded.", "Brak wcześniejszego rozłącznego okna z tym samym planem i licznikiem oraz zużyciem co najmniej 10%. Wykluczono znane różne mnożniki promocji.")}
          note={t(
            "Green is the better side: less limit used, more work per percentage point. Rates divide each window total by its used percentage; model mix, dated prices, missing traffic and unknown promotion terms affect the result.",
            "Zielone = lepiej: mniej zużytego limitu, więcej pracy na punkt procentowy. Przeliczniki to suma okna podzielona przez zużyty procent; wpływają na nie miks modeli, historyczne ceny, braki ruchu i nieznane promocje.")} />
      </section>
      <CycleMilestones cycle={cur} points={chartPoints} typical={pricedHistory} perHour={cur.isActive ? forecast.perHour : null} />
      {shadow && <ShadowCounter shadow={shadow} />}
    </>
  );
  const historyTab = (
    <>
      {railInHero && (
        <CycleRail cycles={model.cycles} pointBasis={card?.pointBasis} points={model.series.points} activeIndex={cur.index} onSelect={selectCycle}
          onInfo={openDrawer} medianPercent={median.peakPercent} medianTokens={median.tokens} />
      )}
      <Card>
        <CardTitle
          title={t("Cycle history · {0}", "Historia cykli · " + account, [account])}
          sub={t(
            "{0} cycles through selected {1}",
            localizedNumber(recent.length) + " cykli do wybranego " + cur.label, [localizedNumber(recent.length), cur.label]
          )}
          help={t("Selected first. Click for a preview, double-click for full details.", "Wybrany u góry. Klik otwiera podgląd, dwuklik pełne szczegóły.")}
        />
        <CycleHistoryTable cycles={recent} selectedIndex={cur.index} medianPercent={median.peakPercent} onOpen={openDrawer} onDetails={selectCycle} />
        <div className="mono" style={{ display: "flex", gap: "var(--s-7)", marginTop: "var(--s-4)", fontSize: "var(--fs-2)", color: "var(--faint)", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 1, height: 9, background: "var(--text)", opacity: 0.55 }} />
            {t(
              "median {0} from {1} earlier closed cycles",
              "mediana " + (median.peakPercent != null ? localizedNumber(median.peakPercent) + "%" : "—") + " z " + localizedNumber(pricedHistory.length) + " wcześniejszych zamkniętych cykli", [(median.peakPercent != null ? localizedNumber(median.peakPercent) + "%" : "—"), localizedNumber(pricedHistory.length)]
            )}
          </span>
          <span style={{ marginLeft: "auto" }}>{t("allowance is inferred from the gauge, not returned by the API", "allowance jest inferowany z gauge, nie zwracany przez API")}</span>
          <FullHistoryLink count={model.cycles.length} onOpen={() => goto("history")} />
        </div>
      </Card>
    </>
  );
  const modelsLabel = `${cur.label} · ${planLabel} · ${dayTime(cur.startIso)} → ${dayTime(cur.isActive ? cur.resetIso ?? cur.endIso : cur.raw.work_to_ts)}${project ? ` · ${project}` : ""}`;
  const modelCount = codexModelCount(modelBreakdown.data);
  return {
    lead,
    planWindows,
    history: historyTab,
    models:
      hasIndexedTelemetry && from && to ? (
        <CodexWindowModels
          account={account}
          data={modelBreakdown.data} loading={modelBreakdown.loading} error={modelBreakdown.error}
          cycleLabel={modelsLabel}
        />
      ) : (
        <MissingSection
          title={hasIndexedTelemetry ? t("No complete model range", "Brak zakresu dla modeli") : t("No data for the current window in the index yet", "Indeks bieżącego okna jeszcze bez danych")}
          detail={
            hasIndexedTelemetry
              ? t(
                  "The active cycle has no complete start and end pair, so the model breakdown cannot be assigned to the window.",
                  "Aktywny cykl nie ma kompletnej pary początku i końca, więc modelowego rozbicia nie da się przypisać do okna."
                )
              : t(
                  "Reset and percentage are current. The model split will appear after the next transcript synchronization.",
                  "Reset i procent są już aktualne. Podział modeli pojawi się po najbliższej synchronizacji transkryptów."
                )
          }
        />
      ),
    traffic: hasIndexedTelemetry ? (
      <>
        <TokenComposition tokens={modelBreakdown.data?.model_detail ? sumWindowTokens(modelBreakdown.data.model_detail.rows) : null} loading={modelBreakdown.loading} error={modelBreakdown.error} />
        <CycleBreakdown
          data={breakdown.data}
          windowHours={cur.windowHours}
          tokensPerPercent={rates.tokens}
          loading={breakdown.loading}
          error={breakdown.error}
          columns={splitColumns(bp, "1.35fr")}
        />
      </>
    ) : (
      <MissingSection
        title={t("No data for the current window in the index yet", "Indeks bieżącego okna jeszcze bez danych")}
        detail={t(
          "Reset and percentage are current. The token, model, and API-equivalent cost breakdown will appear after the next transcript synchronization.",
          "Reset i procent są już aktualne. Podział tokenów, modeli i koszt API-eq pojawią się po najbliższej synchronizacji transkryptów."
        )}
      />
    ),
    provenance: (
      <>
        <Card pad="var(--s-5) var(--s-7)">
          <div className="mono" style={{ fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.55 }}>
            {t(
              "Percentage and reset come directly from the vendor (account/rateLimits/read). The index supplies tokens, API-equivalent cost and models; it does not replace the counter reading, so Codex needs no dollar-per-point rate.",
              "Procent i reset pochodzą wprost od vendora (account/rateLimits/read). Indeks dostarcza tokeny, koszt API-eq i modele; nie zastępuje odczytu licznika, więc Codex nie potrzebuje kursu dolarów na punkt."
            )}
          </div>
        </Card>
        <Card>
          <CardTitle title={t("Insights & anomalies", "Obserwacje i anomalie")} help={t("Calm observations, not alerts.", "Spokojne obserwacje, nie alerty.")} />
          {insights.length === 0 ? (
            <span className="mono" style={{ display: "block", marginTop: "var(--s-6)", fontSize: "var(--fs-4)", color: "var(--muted)" }}>
              {t("Too few closed cycles to make a claim.", "Za mało zamkniętych cykli, żeby cokolwiek twierdzić.")}
            </span>
          ) : (
            <div style={{ marginTop: "var(--s-6)", display: "grid", gridTemplateColumns: bp === "desktop" ? "repeat(3, minmax(0,1fr))" : bp === "tablet" ? "repeat(2, minmax(0,1fr))" : "minmax(0,1fr)", gap: "var(--s-5)" }}>
              {insights.map((insight, index) => (
                <div key={index} style={{ borderRadius: "var(--r-chip)", padding: "var(--s-5) var(--s-6)", background: "var(--sunk)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", marginBottom: "var(--s-2)" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "var(--r-dot)", background: insight.tone, flex: "0 0 6px" }} />
                    <span className="mono" style={{ fontSize: "var(--fs-3)", fontWeight: "var(--fw-medium)", color: insight.tone }}>{insight.kind}</span>
                  </div>
                  <div style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)", marginBottom: "var(--s-1)" }}>{insight.title}</div>
                  <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.5 }}>{insight.body}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </>
    ),
    subs: {
       // The models card has no title of its own: the window, the model count and the counting help stand here.
       models: <>
         {modelsLabel}{hasIndexedTelemetry && from && to && modelCount > 0 ? ` · ${modelCount} ${modelCount === 1 ? t("model", "model") : t("models", "modeli")}` : ""}
         {" · "}{t("from the event index, not the counter", "z indeksu zdarzeń, nie z licznika")}
         {hasIndexedTelemetry && from && to && <>{" "}<CodexModelsHelp data={modelBreakdown.data} /></>}
       </>,
       traffic: t("token types, window days, and 5 h blocks", "rodzaj tokenów, dni okna i bloki 5 h"),
    },
    calibration: (
      <>
        <CodexWindowStats totals={breakdown.data} rates={averages} previousRates={previousRates} open
          historyRates={historical?.samples.map(s => s.rates) ?? []} usedPercent={cur.usedPercent}
          loading={breakdown.loading} historyLoading={history.loading || accounting.loading}
          error={breakdown.error} historyError={history.error || accounting.error} />
        <AllowanceValue model={scopedModel} />
      </>
    ),
  };
}
/** A second counter detected alongside the main one; shown with the forecast, never added to it. */
function ShadowCounter({ shadow }: { shadow: NonNullable<NonNullable<ScreenProps["card"]>["shadow"]> }) {
  const { t } = useI18n();
  return (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s-4)" }}>
                <Eyebrow>{t("Overlapping counter · detected", "Nakładający się licznik · wykryty")}</Eyebrow>
                <EstimateTag
                  title={t(
                    "Detected from at least 80% overlap, a different leading model and at least five times fewer samples than the main counter. This heuristic does not confirm an additional allowance.",
                    "Wykryty na podstawie co najmniej 80% nakładania czasu, innego głównego modelu i co najmniej pięciokrotnie mniejszej liczby próbek. Ta heurystyka nie potwierdza dodatkowego limitu."
                  )}
                >
                  {t("cycle", "cykl")} #{localizedNumber(shadow.index)}
                </EstimateTag>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-4)" }}>
                <div className="ui-figure" style={{ fontSize: "var(--fs-8)" }}>
                  {localizedNumber(shadow.percent)}
                  <span style={{ fontSize: "var(--fs-5)", color: "var(--muted)", letterSpacing: 0 }}>%</span>
                </div>
                <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)" }}>{t("overlapping readings; may be delayed · no confirmed extra quota", "nakładające się odczyty, możliwe opóźnienie · brak potwierdzonego dodatkowego limitu")}</div>
              </div>
              <div
                style={{
                  height: 6,
                  boxSizing: "border-box",
                  marginTop: "var(--s-4)",
                  background: "var(--sunk)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-bar)",
                  overflow: "hidden",
                }}
              >
                <div style={{ height: "100%", width: `${Math.min(100, shadow.percent)}%`, background: "var(--violet)" }} />
              </div>
              <div className="mono" style={{ marginTop: "var(--s-4)", fontSize: "var(--fs-2)", color: "var(--muted)" }}>
                {shadow.top_model ?? t("unknown model", "model nieznany")} · {localizedNumber(shadow.sample_count)} {t("samples", "próbek")}
                {shadow.resets_at_iso ? ` · ${t("reset", "reset")} ${dayTime(shadow.resets_at_iso)}` : ""}
              </div>
            </Card>
          );
}
function buildInsights(model: ReturnType<typeof import("../lib/cycle").buildModel>) {
  const out: { title: string; body: string; tone: string }[] = [];
  const closed = model.typical;
  const cur = model.current;
  if (closed.length >= 3) {
    const exhausted = closed.filter((c) => c.usedPercent >= 95).length;
    if (exhausted > 0) {
      out.push({
        title: translate("Exhaustion risk", "Ryzyko wyczerpania"),
        body: translate("{0} of the last {1} closed cycles reached >95% of the allowance.", `${exhausted} z ostatnich ${closed.length} zamkniętych cykli osiągnęło >95% allowance.`, [exhausted, closed.length]),
        tone: exhausted / closed.length > 0.4 ? "var(--crit)" : "var(--warn)",
      });
    }
    const unused = closed.filter((c) => c.usedPercent < 70).length;
    if (unused > closed.length / 2) {
      out.push({
        title: translate("Unused subscription", "Niewykorzystany abonament"),
        body: translate("{0} of {1} cycles ended below 70% - you regularly lose allowance at the reset.", `${unused} z ${closed.length} cykli skończyło się poniżej 70% — regularnie tracisz allowance przy resecie.`, [unused, closed.length]),
        tone: "var(--ok)",
      });
    }
  }
  if (closed.length >= 4) {
    const half = Math.floor(closed.length / 2);
    const recent = closed.slice(0, half);
    const older = closed.slice(half);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const rb = avg(recent.map((c) => c.burnPerDay ?? 0));
    const ob = avg(older.map((c) => c.burnPerDay ?? 0));
    if (ob > 0 && Math.abs(rb / ob - 1) > 0.15) {
      const up = rb > ob;
      out.push({
        title: up ? translate("Rising pace", "Rosnące tempo") : translate("Falling pace", "Malejące tempo"),
        body: translate(
          "The average burn of the last {0} cycles {1} by {2}% against the earlier ones.",
          `Średni burn ostatnich ${half} cykli ${up ? "wzrósł" : "spadł"} o ${Math.abs(Math.round((rb / ob - 1) * 100))}% wobec wcześniejszych.`, [half, up ? "rose" : "fell", Math.abs(Math.round((rb / ob - 1) * 100))],
        ),
        tone: up ? "var(--warn)" : "var(--ok)",
      });
    }
  }
  const allowances = model.cycles.map((c) => c.calibration.allowanceTokens).filter((a): a is number => a != null);
  if (allowances.length >= 4 && model.median.allowanceTokens) {
    const last = allowances[0]!;
    const d = (last / model.median.allowanceTokens - 1) * 100;
    if (Math.abs(d) > 8) {
      out.push({
        title: translate("Observed allowance changed", "Zmiana observed allowance"),
        body: translate(
          "The last observed allowance is {0}% {1} the median. The value is inferred from the gauge, not returned by the API.",
          `Ostatni obserwowany allowance jest o ${Math.abs(Math.round(d))}% ${d < 0 ? "niższy" : "wyższy"} od mediany. Wartość jest inferowana z gauge, nie zwracana przez API.`, [Math.abs(Math.round(d)), d < 0 ? "below" : "above"],
        ),
        tone: "var(--violet)",
      });
    }
  }
  if (cur && cur.calibration.confidence === "low") {
    out.push({
      title: translate("Gauge is lagging", "Gauge się opóźnia"),
      body: translate(
        "This cycle's calibration is weak: {0}. Treat the token figures as approximate.",
        `Kalibracja tego cyklu jest słaba: ${cur.calibration.reason}. Liczby tokenowe traktuj jako orientacyjne.`, [cur.calibration.reason],
      ),
      tone: "var(--faint)",
    });
  }
  return out.slice(0, 6).map((i) => ({ ...i, kind: KIND_OF[i.tone] ?? "informational" }));
}
const KIND_OF: Record<string, string> = {
  "var(--crit)": "risk",
  "var(--warn)": "noteworthy",
  "var(--ok)": "noteworthy",
  "var(--violet)": "noteworthy",
  "var(--faint)": "informational",
};
