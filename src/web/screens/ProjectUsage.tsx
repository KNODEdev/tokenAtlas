import { DataTable, TableColGroup, TableRow } from "../components/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePlanCatalog } from "../lib/use-plan-catalog";
import { api, type ApiProject } from "../lib/api";
import { subscriptionColor } from "../components/mix";
import { subscriptionNameLookup, type RosterCard } from "../lib/roster";
import { useAsync } from "../lib/useAsync";
import { useDebounced } from "../lib/useDebounced";
import { useFillHeight } from "../lib/useFillHeight";
import { isBucket } from "../../projects/bucket";
import { useI18n } from "../lib/i18n";
import { Card, CardTitle, EmptyState, ErrorState, LoadingCard, ProjectDrawer, Tabs, Th } from "../components";
import { countLabel } from "./project-usage/format";
import { costForRequest, rangeDaysOf, rankingCostOf, sortSubjects, spanDays, subjectKey, type GeneratedProjectCost, type SortKey } from "./project-usage/model";
import { Controls, sinceOf, useUtcNowMs } from "./project-usage/Controls";
import { HowWeCount, ProjectTiles } from "./project-usage/ProjectUsageSummary";
import { SubjectRowView } from "./project-usage/SubjectRowView";
import { MergeBar } from "./project-usage/MergeBar";
import "./History.css";
import "./Projects.css";

export type { SortKey, MixSlice, GeneratedProjectCost } from "./project-usage/model";
export { rankingCostOf, agentParallelism, sortSubjects, costForRequest } from "./project-usage/model";
export { ProjectTiles } from "./project-usage/ProjectUsageSummary";
export { EstimatedActiveTime, SubjectRowView } from "./project-usage/SubjectRowView";

const SORT_DEFS: Array<{ value: SortKey; en: string; pl: string }> = [
  { value: "api", en: "API-eq", pl: "API-eq" },
  { value: "tokens", en: "Tokens", pl: "Tokeny" },
  { value: "time", en: "Active time", pl: "Czas aktywny" },
  { value: "share", en: "Plan-cost share", pl: "Udział w koszcie" },
];
export function ProjectUsage({
  projects = [],
  cards = [],
  onChanged,
}: {
  projects?: ApiProject[];
  cards?: RosterCard[];
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [idleGap, setIdleGap] = useState(15);
  const [range, setRange] = useState("30");
  const [sortKey, setSortKey] = useState<SortKey>("api");
  const [mutationGeneration, setMutationGeneration] = useState(0);
  const [drawerRef, setDrawerRef] = useState<{ kind: "project" | "repo"; id: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const settledGap = useDebounced(idleGap);
  const gapPending = settledGap !== idleGap;
  const nowMs = useUtcNowMs();
  const since = sinceOf(range, nowMs);
  const list = useAsync(
    () => api.subjects({ idle_gap: settledGap, since }),
    [settledGap, since],
  );
  const costState = useAsync<GeneratedProjectCost>(
    async signal => ({ generation: mutationGeneration, payload: await api.projectCost({ since }, signal) }),
    [since, mutationGeneration],
  );
  const cost = costForRequest(costState, { generation: mutationGeneration, since });
  const costLoading = cost == null && costState.error == null;
  const isListMatching =
    list.data != null &&
    (list.data.since ?? null) === (since ?? null) &&
    list.data.idle_gap_minutes === settledGap;
  // Stale reports are re-read every 2 s during sync; hiding the list while one runs blanked the ranking and the drawer.
  const listData = isListMatching ? list.data : null;
  const catalog = usePlanCatalog();
  const costOf = useMemo(() => rankingCostOf(cost), [cost, catalog]);
  const nameOf = useMemo(() => subscriptionNameLookup(cards), [cards]);
  const rangeDays = rangeDaysOf(cost);
  const allRows = useMemo(() => sortSubjects(listData?.subjects ?? [], sortKey, costOf), [listData, sortKey, costOf]);
  const rows = useMemo(
    () => allRows.filter((r) => !(r.kind === "project" && isBucket(r.id))),
    [allRows],
  );
  const liveDrawer = useMemo(() => {
    if (!drawerRef || !listData) return null;
    return listData.subjects.find((r) => r.kind === drawerRef.kind && r.id === drawerRef.id) ?? null;
  }, [drawerRef, listData]);
  useEffect(() => {
    if (!drawerRef || !listData) return;
    if (!listData.subjects.some((r) => r.kind === drawerRef.kind && r.id === drawerRef.id)) {
      setDrawerRef(null);
    }
  }, [drawerRef, listData]);
  const drawerKey = drawerRef ? `${drawerRef.kind}:${drawerRef.id}` : null;
  const pickedRows = useMemo(() => rows.filter((r) => picked.has(`${r.kind}:${r.id}`)), [rows, picked]);
  const togglePick = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // The ranking scrolls on its own down to the window's bottom edge instead of stopping at a fixed height.
  const ranking = useRef<HTMLDivElement>(null);
  const rankingHeight = useFillHeight(ranking, [listData != null, rows.length, pickedRows.length > 0, costLoading]);
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  const controls = <Controls range={range} setRange={setRange} idleGap={idleGap} setIdleGap={setIdleGap} pending={gapPending} />;
  if (!listData) {
    return (
      <div className="projects">
        {controls}
        <LoadingCard label={t("Loading projects", "Wczytuję projekty")} height={420} shape="table" />
      </div>
    );
  }
  const maxApi = Math.max(...rows.map((r) => costOf.api.get(subjectKey(r)) ?? 0), 0.01);
  const totalSeconds = allRows.reduce((a, r) => a + (r.session_seconds ?? r.active_seconds), 0);
  return (
    <div className="projects">
      {controls}
      <ProjectTiles
        totalSeconds={totalSeconds}
        idleGap={listData.idle_gap_minutes}
        days={spanDays(range, cost)}
        cost={cost}
        loading={costLoading}
        error={costState.error}
      />
      <Card frame={false}>
        <div className="projects-head">
          <CardTitle
            title={`${t("Ranking", "Ranking")} · ${rows.length} ${countLabel(t, rows.length, "item", "items", "pozycja", "pozycje", "pozycji")}`}
            right={<div className="ui-toolbar">
              <Tabs value={sortKey} onChange={setSortKey} options={SORT_DEFS.map((sort) => ({ value: sort.value, label: t(sort.en, sort.pl) }))} />
              <HowWeCount cost={cost} />
            </div>}
          />
          {cost && cost.subscriptions.length > 0 && <div className="archive-legend">
            {cost.subscriptions.map((s) => <span key={s.id}><i style={{ background: subscriptionColor(s.id) }} />{nameOf(s.id)}{s.paid_usd == null ? ` (${t("cost unavailable", "brak kosztu")})` : ""}</span>)}
          </div>}
        </div>
        {pickedRows.length > 0 && (
          <MergeBar
            picked={pickedRows}
            projects={projects}
            onClear={() => setPicked(new Set())}
            onMerged={() => {
              setPicked(new Set());
              setDrawerRef(null);
              setMutationGeneration((generation) => generation + 1);
              list.reload();
              onChanged?.();
            }}
          />
        )}
        {rows.length === 0 ? (
          <div style={{ padding: "20px 16px" }}>
            <EmptyState
              title={t("No projects or repositories in the ranking", "Brak projektów i repo w rankingu")}
              detail={t(
                "The repository is derived from the event's working path. Run `bun run remap` or sync to fill this column.",
                "Repo jest wyprowadzane ze ścieżki roboczej zdarzenia. Uruchom `bun run remap` albo synchronizację, żeby wypełnić kolumnę.",
              )}
            />
          </div>
        ) : (
          <div className="projects-ranking" ref={ranking} style={rankingHeight ? { maxHeight: rankingHeight } : undefined}>
            <DataTable tableId="ProjectUsage:0">
              <TableColGroup>
                <col style={{ width: 34 }} />
                <col style={{ width: "30%" }} />
                <col />
                <col style={{ width: 78 }} />
                <col style={{ width: 116 }} />
                <col style={{ width: 128 }} />
              </TableColGroup>
              <thead>
                <TableRow header>
                  <Th columnId="c0"> </Th>
                  <Th columnId="c1">{t("Project", "Projekt")}</Th>
                  <Th columnId="c2" title={t("What the traffic would cost at API rates without a subscription, split by subscription.", "Ile ten ruch kosztowałby po cenniku API bez abonamentu, w podziale na subskrypcje.")}>{t("API-eq by subscription", "API-eq wg subskrypcji")}</Th>
                  <Th columnId="c3" align="right">{t("Tokens", "Tokeny")}</Th>
                  <Th columnId="c4" align="right" title={t("Overlapping agents count once per computer; different computers add up.", "Równocześni agenci liczą się raz na komputer; czas różnych komputerów się sumuje.")}>{t("Active time", "Czas aktywny")}</Th>
                  <Th columnId="c5" align="right" title={t("Share of the declared plan cost; only subscriptions with a price.", "Udział w deklarowanym koszcie planów; tylko subskrypcje z ceną.")}>{t("Plan-cost share", "Udział w koszcie")}</Th>
                </TableRow>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = `${r.kind}:${r.id}`;
                  return (
                    <SubjectRowView
                      key={key}
                      row={r}
                      active={key === drawerKey}
                      picked={picked.has(key)}
                      maxApi={maxApi}
                      billed={costOf.billed.get(subjectKey(r)) ?? null}
                      billedComplete={costOf.billedComplete.get(subjectKey(r)) ?? true}
                      apiUsd={costOf.api.get(subjectKey(r)) ?? null}
                      mix={costOf.mix.get(subjectKey(r)) ?? null}
                      nameOf={nameOf}
                      sharePct={costOf.share.get(subjectKey(r)) ?? null}
                      idleGap={listData.idle_gap_minutes}
                      onClick={() => setDrawerRef({ kind: r.kind, id: r.id })}
                      onPick={() => togglePick(key)}
                    />
                  );
                })}
              </tbody>
            </DataTable>
          </div>
        )}
      </Card>
      {liveDrawer && (
        <ProjectDrawer
          key={`${liveDrawer.kind}:${liveDrawer.id}`}
          subject={liveDrawer}
          cost={cost}
          costLoading={costLoading}
          costError={costState.error}
          onCostRetry={costState.reload}
          cards={cards}
          since={since}
          rangeDays={rangeDays}
          idleGap={listData.idle_gap_minutes}
          onClose={() => setDrawerRef(null)}
        />
      )}
    </div>
  );
}
