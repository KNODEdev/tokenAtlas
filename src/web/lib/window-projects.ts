import type { WindowProject, WindowProjectsResponse } from "../../shared/window-projects";
import type { CycleView } from "./cycle";
import type { RailWindow } from "./windows";
import { trafficRangeOf } from "./codex-window-stats";
import { compact, pct } from "./format";

export const ALL_WINDOW_PROJECTS = "__all_window_projects";

export function overviewProjectRange(cycle?: CycleView | null, window?: RailWindow | null) {
  if (cycle) return trafficRangeOf(cycle);
  return window?.startIso && window.resetIso ? { from: window.startIso, until: window.resetIso } : null;
}
export function windowProjectsForScope(data: WindowProjectsResponse | null, account: string, from: string, until: string) {
  return data?.account.toLowerCase() === account.toLowerCase() && Date.parse(data.from) === Date.parse(from)
    && Date.parse(data.until) === Date.parse(until) ? data : null;
}
export const selectedWindowProject = (data: WindowProjectsResponse, id: string): WindowProject | undefined =>
  data.projects.find(project => id === "unassigned" ? project.project_id === null : project.project_id === id);
export function windowProjectOptions(data: WindowProjectsResponse, unassigned: string) {
  const total = data.projects.reduce((sum, project) => sum + project.tokens, 0);
  return data.projects.filter(project => project.calls > 0 || project.tokens > 0).map(project => ({
    value: project.project_id ?? "unassigned",
    label: `${project.name ?? unassigned} · ${compact(project.tokens)}${total > 0 ? ` · ${pct(project.tokens / total * 100, 1)}` : ""}`,
  }));
}
/** Token-weighted allocation of the account reading, never an independent provider measurement. */
export function projectTokenAllocation(data: WindowProjectsResponse, id: string, usedPercent?: number | null) {
  const project = selectedWindowProject(data, id), total = data.projects.reduce((sum, row) => sum + row.tokens, 0);
  const share = project && total > 0 ? project.tokens / total : null;
  const valid = data.projects.every(row => row.invalid_calls === 0);
  const factor = valid && total > 0 && usedPercent != null && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent < 100
    ? usedPercent / total : null;
  return { project, share, factor, percent: project && factor !== null ? project.tokens * factor : null };
}
