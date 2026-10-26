import { useEffect, useState } from "react";
import type { CycleView } from "../lib/cycle";
import type { RailWindow } from "../lib/windows";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { ALL_WINDOW_PROJECTS, overviewProjectRange, windowProjectOptions, windowProjectsForScope } from "../lib/window-projects";
import { Selector } from "./ui";
import { WindowProjects } from "./WindowProjects";

export function OverviewProjectSelector({ account, cycle, window, range: requestedRange, value, onChange }: {
  account: string; cycle?: CycleView | null; window?: RailWindow | null; range?: { from: string; until: string } | null; value: string; onChange: (value: string) => void;
}) {
  const { t } = useI18n(), range = requestedRange ?? overviewProjectRange(cycle, window);
  const state = useAsync(signal => range ? api.windowProjects({ account, ...range }, signal) : Promise.resolve(null), [account, range?.from, range?.until]);
  const data = range ? windowProjectsForScope(state.data, account, range.from, range.until) : null;
  const projects = data ? windowProjectOptions(data, t("Unassigned", "Nieprzypisane")) : [];
  const selected = value === "" || value === ALL_WINDOW_PROJECTS || projects.some(option => option.value === value) ? value : "";
  useEffect(() => {
    if (data && value && value !== ALL_WINDOW_PROJECTS && !data.projects.some(project => (project.project_id ?? "unassigned") === value)) onChange("");
  }, [data, value, onChange]);
  const pending = !!range && !data;
  return <Selector bare label={t("project in window", "projekt w oknie")} ariaLabel={t("Project in selected window", "Projekt w wybranym oknie")}
    strong={selected !== ""} value={pending ? "__pending" : selected} onChange={onChange} options={[
      { value: "", label: t("Account total", "Całe konto") },
      ...(pending ? [{ value: "__pending", label: state.error ? t("Read failed", "Błąd odczytu") : t("Loading…", "Wczytywanie…"), disabled: true }]
        : [{ value: ALL_WINDOW_PROJECTS, label: t("All projects", "Wszystkie projekty") }, ...projects]),
    ]} />;
}
export function RailProjectSelection({ account, window }: { account: string; window?: RailWindow | null }) {
  const [project, setProject] = useState("");
  const range = overviewProjectRange(null, window);
  if (!range) return null;
  const control = <OverviewProjectSelector account={account} window={window} value={project} onChange={setProject} />;
  // The picker keeps the right end of the row; with a project chosen it moves into that chart's control row.
  return project
    ? <WindowProjects account={account} {...range} project={project} chartOnly usedPercent={window?.scope == null ? window?.usedPercent : null} control={control} />
    : <div className="ui-toolbar"><span style={{ marginLeft: "auto" }}>{control}</span></div>;
}
