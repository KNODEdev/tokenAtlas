import type { Database } from "../db/sqlite";
import { loadProjects } from "./remap";
import { PROJECT_TABLE_OF, projectRules, subjectOf, subjectSql, type ProjectRules } from "./resolve";

/**
 * The project rules of projects.json applied to stored rows (docs/stored-activity-plan-2026-10-07.md, step 7): ledger
 * dimensions are keyed by the place of a call, so a reader derives a row's project and subject from the place and, for
 * dated rules only, from the raw day of its calls. Nothing is written when the rules change.
 */
export const currentProjectRules = (db: Database): ProjectRules => projectRules(db, loadProjects);
/** What the project of a stored row depends on besides the rows: a memo of read rows that carry projects keys on it. */
export const projectRulesStamp = (db: Database): string => currentProjectRules(db).resolver.stamp;

/** The raw day of a stored usage-ledger row: its UTC day moved by its dimension's shift (-1, 0 or 1). */
export const rawDayOf = (day: string, shift: number | null | undefined) =>
  !shift ? day : new Date(Date.parse(`${day}T00:00:00.000Z`) + shift * 86_400_000).toISOString().slice(0, 10);

/**
 * `project_id` and `subject` of the usage-ledger dimension `alias` on the UTC day `day`, as SQL. A provider whose raw table
 * the rules do not cover (Gemini) has neither.
 */
export function usagePlaceSql(db: Database, provider: string, alias = "m", day = "d.day"): { project: string; subject: string } {
  const table = PROJECT_TABLE_OF[provider];
  if (!table) return { project: "NULL", subject: "NULL" };
  const raw = `(CASE WHEN ${alias}.shift IS NULL OR ${alias}.shift=0 THEN ${day} ELSE date(${day}, ${alias}.shift || ' days') END)`;
  const project = currentProjectRules(db).sql(table, { store: `${alias}.home`, cwd: `${alias}.cwd`, project: `${alias}.project`, repo: `${alias}.repo`, day: raw });
  return { project, subject: subjectSql(project, `${alias}.repo`) };
}
/** `project_id` of the Codex dimension `alias` on the pricing day `day`, as SQL. */
export const codexProjectSql = (db: Database, alias = "d", day = "a.day") =>
  currentProjectRules(db).sql("events", { store: `${alias}.home`, cwd: `${alias}.cwd`, project: `${alias}.project`, repo: `${alias}.repo`, source: `${alias}.source`, nested: `${alias}.nested`, day });

export interface StoredPlace { home: string | null; cwd: string | null; project: string | null; repo: string | null; shift?: number | null; source?: string | null; nested?: string | null }
/** The project of a stored place of `provider` on a UTC day (Codex: its pricing day), in JavaScript. */
export function placeProject(rules: ProjectRules, provider: string, place: StoredPlace, day: string): string | null {
  const table = PROJECT_TABLE_OF[provider];
  if (!table) return null;
  return rules.projectOf(table, { store: place.home, cwd: place.cwd, project: place.project, repo: place.repo, source: place.source, nested: place.nested }, rawDayOf(day, place.shift));
}
/** The subject (`p:` project, else `r:` repository) of a stored place on a day; none for a provider without rules (Gemini). */
export const placeSubject = (rules: ProjectRules, provider: string, place: StoredPlace, day: string) =>
  PROJECT_TABLE_OF[provider] ? subjectOf(placeProject(rules, provider, place, day), place.repo) : null;
