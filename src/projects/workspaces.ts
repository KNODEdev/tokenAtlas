import type { ProjectMatch, ProjectsConfig } from "./remap";
import { deriveRepo } from "./repo";

export interface ProjectRule { id: string; m: ProjectMatch }
const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const literal = (value: string) => !/[*?[]/.test(value);
const slug = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "");

/** Known agent workspace layouts, derived from declared roots, never from a substring of an event's path. */
export function workspaceRules(cfg: ProjectsConfig): ProjectRule[] {
  const rules: ProjectRule[] = [];
  const seen = new Set<string>();
  for (const project of cfg.projects) {
    if (project.id === "_tmp") continue;
    for (const match of project.matches ?? []) {
      if (!match.cwd || !literal(match.cwd) || match.repo || match.project) continue;
      const root = normalize(match.cwd), base = root.split("/").pop()!;
      if (!base || !/^(?:[a-z]:\/|\/)/.test(root)) continue;
      const named = slug(base) === slug(project.id) || slug(base) === slug(project.name);
      if (!named && /(?:-wt|-worktree)(?:-|$)/.test(base)) continue;
      const repo = deriveRepo(root, cfg.repo).repo?.split("/").pop();
      // A rule for a package/subdirectory must not acquire every workspace named "src" or "api".
      if (base !== repo && slug(base) !== slug(project.id) && slug(base) !== slug(project.name)) continue;
      const paths = [
        `${root}-wt`, `${root}-wt/*`, `${root}-wt-*`,
        `${root}-worktree`, `${root}-worktree/*`, `${root}-worktree-*`,
        `*/.codex*/worktrees/*/${base}`, `*/.codex*/worktrees/*/${base}/*`,
      ];
      for (const role of ["execution", "assessment", "bench"]) {
        paths.push(`*/documents/codex/????-??-??/${base}-${role}-*`);
      }
      // Claude encodes the original absolute workspace in its scratchpad container.
      const encoded = root.replace(/[^a-z0-9]/g, "-");
      for (const temp of ["*/temp", "*/tmp", "/tmp", "/private/tmp"]) {
        paths.push(`${temp}/claude/${encoded}`, `${temp}/claude/${encoded}/*`, `${temp}/claude-*/${encoded}`, `${temp}/claude-*/${encoded}/*`);
        for (const role of ["req[0-9]", "req-", "ur[0-9]", "ur-", "execution-", "assessment-", "bench-", "ui-", "smoke-", "test-", "verify-", "review-"]) {
          paths.push(`${temp}/${base}-${role}*`);
        }
      }
      for (const cwd of paths) {
        const m: ProjectMatch = { cwd, ...(match.store ? { store: match.store } : {}),
          ...(match.from ? { from: match.from } : {}), ...(match.until ? { until: match.until } : {}) };
        const key = JSON.stringify([project.id, m]);
        if (!seen.has(key)) { seen.add(key); rules.push({ id: project.id, m }); }
      }
    }
  }
  return rules;
}
