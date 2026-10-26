export interface RepoConfig {
  roots?: string[];
  nested_groups?: string[];
}
const DEFAULT_ROOTS = ["repos"];
const DEFAULT_NESTED = ["clients"];
export interface DerivedRepo {
  repo: string | null;
  group: string | null;
}
const EMPTY: DerivedRepo = { repo: null, group: null };
function segments(p: string): string[] {
  return p.replace(/\\/g, "/").split("/").filter(Boolean);
}
export function deriveRepo(cwd: string | null | undefined, cfg: RepoConfig = {}): DerivedRepo {
  if (!cwd) return EMPTY;
  const roots = (cfg.roots ?? DEFAULT_ROOTS).map((r) => r.toLowerCase());
  const nested = new Set((cfg.nested_groups ?? DEFAULT_NESTED).map((g) => g.toLowerCase()));
  const parts = segments(cwd);
  const lower = parts.map((p) => p.toLowerCase());
  let rootAt = -1;
  for (let i = 0; i < lower.length; i++) {
    if (roots.includes(lower[i]!)) rootAt = i;
  }
  if (rootAt === -1) return EMPTY;
  const rest = parts.slice(rootAt + 1);
  if (rest.length === 0) return EMPTY;
  const group = rest[0]!;
  if (rest.length === 1) {
    return { repo: null, group };
  }
  if (nested.has(group.toLowerCase())) {
    return rest.length >= 3 ? { repo: `${rest[1]}/${rest[2]}`, group } : { repo: null, group };
  }
  return { repo: rest[1]!, group };
}
