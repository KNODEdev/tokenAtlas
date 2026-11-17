import { BUCKET_NAME, BUCKET_ID, isBucket } from "../../projects/bucket";
import { filterRows, type Translate } from "./projects/assignment";
import { type UnassignedRow, api } from "../lib/api";
import { useDeferredValue, useMemo, useState } from "react";
import type { ScreenProps } from "../lib/screens";
import type { RosterCard } from "../lib/roster";
import { useAsync } from "../lib/useAsync";
import { useWriting } from "../lib/useWriting";
import { ProjectUsage } from "./ProjectUsage";
import { ProjectPlanPanel } from "./ProjectPlanPanel";
import { useI18n } from "../lib/i18n";
import { ErrorState, GhostButton, Tabs } from "../components/ui";
import { ProjectRulesTable } from "./projects/ProjectRulesTable";
import { AssignmentTable } from "./projects/AssignmentTable";
import "./Projects.css";

const ANALYSIS_TABS = new Set(["usage", "plan"]);
const analysisTabs = (t: Translate) => [
  { value: "usage", label: t("Ranking", "Ranking") },
  { value: "plan", label: t("Plan simulation", "Symulacja planu"), title: t("What a project's traffic would cost on another plan", "Ile ruch projektu kosztowałby w innym planie") },
];
/** The editors behind "Manage projects" (IA-2026-10-19 v1.1, PR-3); not a menu entry of their own. */
const manageTabs = (t: Translate, declared?: number, unassigned?: number, bucket?: number) => [
  { value: "projects", label: t("Rules", "Reguły"), badge: declared, title: t("Declared projects and their rules", "Zadeklarowane projekty i ich reguły") },
  {
    value: "unassigned",
    label: t("Unassigned", "Nieprzypisane"),
    badge: unassigned,
    title: t("Directories with events that no rule matches", "Katalogi z eventami, których żadna reguła nie łapie"),
  },
  {
    value: "bucket",
    label: BUCKET_NAME,
    badge: bucket,
    title: t("Bucket for directories we do not want to assign - it can be reviewed and emptied", "Worek na katalogi, których nie chcemy przypisywać - można go przejrzeć i opróżnić"),
  },
];

const NO_ROWS = { project_id: null as string | null, total: 0, total_unfiltered: 0, query: "", rows: [] as UnassignedRow[] };
/** The whole list is read once and searched in the browser: a search never waits for the server. */
const ALL_ROWS = 100_000;
/** Rows drawn at once (largest first); the search and the selection still cover the whole list. */
const SHOWN_ROWS = 300;
const NONE: UnassignedRow[] = [];

export function Projects({ cards = [] }: ScreenProps & { cards?: RosterCard[] }) {
  const { t } = useI18n();
  const [tab, setTab] = useState("usage");
  const [query, setQuery] = useState("");
  const [bucketQuery, setBucketQuery] = useState("");
  const state = useAsync(() => api.projects(), []);
  const unassigned = useAsync(() => api.projectsUnassigned({ limit: ALL_ROWS }), []);
  const hasBucket = (state.data?.projects ?? []).some((p) => isBucket(p.id));
  const bucket = useAsync(
    () =>
      hasBucket
        ? api.projectsRows({ project_id: BUCKET_ID, limit: ALL_ROWS })
        : Promise.resolve({ ...NO_ROWS, project_id: BUCKET_ID }),
    [hasBucket],
  );
  const unassignedAll = unassigned.data?.rows ?? NONE;
  const bucketAll = bucket.data?.rows ?? NONE;
  const deferredQuery = useDeferredValue(query);
  const deferredBucketQuery = useDeferredValue(bucketQuery);
  const unassignedFound = useMemo(() => filterRows(unassignedAll, deferredQuery), [unassignedAll, deferredQuery]);
  const bucketFound = useMemo(() => filterRows(bucketAll, deferredBucketQuery), [bucketAll, deferredBucketQuery]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const writing = useWriting();
  const reloadAll = () => {
    state.reload();
    unassigned.reload();
    bucket.reload();
  };
  const remap = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.projectsRemap();
      reloadAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const data = state.data;
  // The tabs stand under the screen title and the page has no frame of its own (paper-atlas §3, §7);
  // the declared-project count rides on the Rules tab instead of a card title repeating "Projects".
  return (
    <>
      <div className="projects-tabs" role="group" aria-label={t("Projects view", "Widok projektów")}>
        <Tabs
          variant="sections"
          value={tab}
          onChange={setTab}
          options={ANALYSIS_TABS.has(tab) ? analysisTabs(t) : manageTabs(t, data?.projects.length, unassigned.data?.total_unfiltered, bucket.data?.total_unfiltered)}
        />
        {ANALYSIS_TABS.has(tab)
          ? <GhostButton onClick={() => setTab((unassigned.data?.total_unfiltered ?? 0) > 0 ? "unassigned" : "projects")}
              title={t("Rules, unassigned directories and the bucket", "Reguły, nieprzypisane katalogi i worek")}>
              {t("Manage projects", "Zarządzaj projektami")}{(unassigned.data?.total_unfiltered ?? 0) > 0 ? ` (${unassigned.data!.total_unfiltered})` : ""}
            </GhostButton>
          : <GhostButton onClick={() => setTab("usage")}>{`← ${t("Ranking", "Ranking")}`}</GhostButton>}
        {tab === "projects" && <GhostButton onClick={remap} disabled={busy || writing} title={t("Recalculate project_id after manually editing projects.json", "Przelicz project_id po ręcznej edycji projects.json")}>
          {busy ? t("recalculating…", "przeliczam…") : `↻ ${t("remap", "przelicz")}`}
        </GhostButton>}
      </div>
      <div className="ui-tab-page">
      {err && <ErrorState message={err} onRetry={() => setErr(null)} />}
      {writing && <WritingBanner />}
      {tab === "usage" ? (
        <ProjectUsage projects={data?.projects ?? []} cards={cards} onChanged={reloadAll} />
      ) : tab === "plan" ? (
        <ProjectPlanPanel />
      ) : tab === "projects" ? (
        <ProjectRulesTable state={state} onChanged={reloadAll} />
      ) : tab === "bucket" ? (
        <AssignmentTable
          source={BUCKET_ID}
          rows={bucketFound.slice(0, SHOWN_ROWS)}
          found={bucketFound}
          allRows={bucketAll}
          total={bucketFound.length}
          totalAll={bucket.data?.total_unfiltered ?? 0}
          query={bucketQuery}
          onQuery={setBucketQuery}
          pending={deferredBucketQuery !== bucketQuery}
          loading={bucket.loading && !bucket.data}
          error={bucket.error}
          projects={data?.projects ?? []}
          cards={cards}
          onRetry={bucket.reload}
          onAssigned={reloadAll}
        />
      ) : (
        <AssignmentTable
          source={null}
          rows={unassignedFound.slice(0, SHOWN_ROWS)}
          found={unassignedFound}
          allRows={unassignedAll}
          total={unassignedFound.length}
          totalAll={unassigned.data?.total_unfiltered ?? 0}
          query={query}
          onQuery={setQuery}
          pending={deferredQuery !== query}
          loading={unassigned.loading && !unassigned.data}
          error={unassigned.error}
          projects={data?.projects ?? []}
          cards={cards}
          onRetry={unassigned.reload}
          onAssigned={reloadAll}
        />
      )}
      </div>
    </>
  );
}

function WritingBanner() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "var(--s-3) var(--s-5)",
        margin: "0 0 var(--s-5)",
        borderRadius: "var(--r-chip)",
        background: "var(--accent-soft)",
      }}
    >
      <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--accent)", fontWeight: 600 }}>
        {t("saving rules and recalculating mapping…", "zapisuję reguły i przeliczam mapowanie…")}
      </span>
      <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
        {t("the database has one writer, so the list and search show the pre-change state until saving finishes", "baza ma jednego pisarza, więc do końca zapisu lista i wyszukiwarka pokazują stan sprzed zmiany")}
      </span>
    </div>
  );
}
