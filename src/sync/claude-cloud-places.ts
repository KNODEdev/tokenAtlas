import fs from "node:fs";
import path from "node:path";
import type { ProjectsConfig } from "../projects/remap";

/**
 * Where a cloud session's repositories live on this computer (decision 3 in
 * docs/cloud-sessions-import-2026-10-23.md). A cloud container checks each repository out at
 * `/home/user/<name>`; the parser rewrites that root to the local clone of the same repository, so
 * the existing project rules, repository and group apply unchanged. The answer is recorded in the
 * archive with the session, never recomputed while parsing.
 */
export const CLOUD_CHECKOUT_ROOT = "/home/user";

export interface CloudPlace {
  /** The repository URL the provider lists for the session. */
  repository: string;
  /** The checkout root inside the container. */
  remote: string;
  /** The local clone, or null when none is known (the project then stays unresolved). */
  local: string | null;
}
export interface CloudRepositoryConfig {
  /** Repository moved between owners: the URL a session used → the URL the local clone has. */
  aliases?: Record<string, string>;
  /** A repository whose clone no project rule names: URL → local directory. */
  paths?: Record<string, string>;
}

/** `github.com/owner/name`, lower-cased; null for anything that is not a repository URL. */
const REPOSITORY_URL = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
export function repositoryKey(url: string): string | null {
  const match = REPOSITORY_URL.exec(url.trim());
  return match ? `${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : null;
}
/** The checkout directory name keeps the URL's case (`SampleApp`, not `sampleapp`). */
const repositoryName = (url: string) => REPOSITORY_URL.exec(url.trim())?.[3] ?? null;

/** Remote URLs from a checkout's Git config (a worktree reads its common directory). */
export function gitRemoteUrls(directory: string): string[] {
  let gitDir = path.join(directory, ".git");
  try {
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"))?.[1]?.trim();
      if (!pointer) return [];
      gitDir = path.resolve(directory, pointer);
      const common = path.join(gitDir, "commondir");
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, "utf8").trim());
    }
    return [...fs.readFileSync(path.join(gitDir, "config"), "utf8").matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map(m => m[1]!);
  } catch { return []; }
}

/** Local clones by repository key, from the literal directories of the project rules. */
export function localRepositories(projects: ProjectsConfig, remotes: (dir: string) => string[] = gitRemoteUrls): Map<string, string[]> {
  const clones = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const project of projects.projects) for (const match of project.matches ?? []) {
    if (!match.cwd || /[*?[]/.test(match.cwd)) continue;
    const dir = match.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    for (const url of remotes(dir)) {
      const key = repositoryKey(url);
      if (key && !clones.get(key)?.includes(dir)) clones.set(key, [...clones.get(key) ?? [], dir]);
    }
  }
  return clones;
}

/** The clone named like the repository (not a suffixed worktree), or the only one. */
function chooseClone(name: string, dirs: readonly string[]): string | null {
  const base = (dir: string) => dir.split("/").pop()!;
  return dirs.find(dir => base(dir) === name) ?? dirs.find(dir => base(dir).toLowerCase() === name.toLowerCase())
    ?? (dirs.length === 1 ? dirs[0]! : null);
}

/** One place per repository the session lists, in the provider's order. */
export function cloudPlaces(sources: unknown, clones: Map<string, string[]>, config: CloudRepositoryConfig = {}): CloudPlace[] {
  const aliases = new Map(Object.entries(config.aliases ?? {}).map(([from, to]) => [repositoryKey(from) ?? from.toLowerCase(), repositoryKey(to) ?? to.toLowerCase()]));
  const paths = new Map(Object.entries(config.paths ?? {}).map(([url, dir]) => [repositoryKey(url) ?? url.toLowerCase(), dir.replace(/\\/g, "/").replace(/\/+$/, "")]));
  const places: CloudPlace[] = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const url = (source as { type?: unknown; url?: unknown })?.url;
    if ((source as { type?: unknown }).type !== "git_repository" || typeof url !== "string") continue;
    const key = repositoryKey(url), name = repositoryName(url);
    if (!key || !name) continue;
    const target = aliases.get(key) ?? key;
    const local = paths.get(key) ?? paths.get(target) ?? chooseClone(target.split("/").pop()!, clones.get(target) ?? []);
    places.push({ repository: url, remote: `${CLOUD_CHECKOUT_ROOT}/${name}`, local });
  }
  return places;
}
