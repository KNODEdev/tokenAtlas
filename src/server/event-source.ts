import { normEraKey, normEraVendor } from "./eras";
import type { SourceDeclaration } from "./archive-source";
import { MACHINE } from "../config/paths";

/**
 * The source of an event: the archive folder its file lives in, `<provider>/<folder>` under the
 * archive root, lower-cased — the same key `account_periods.source` uses (register version 8,
 * docs/register-v8-design-2026-09-22.md §1–2). An event knows nothing else about where it came
 * from, and nothing here consults an account.
 */
export interface ArchiveFolder { key: string; provider: string; name: string | null }

/**
 * The folder a path belongs to, or null when the path is outside the archive — a live local
 * mirror such as `C:\Users\sample_a\.codex` names no folder. `name` keeps the folder's own
 * spelling, which the lower-cased key has lost.
 */
export function archiveFolderOf(file: string | null | undefined, root: string): ArchiveFolder | null {
  if (!file) return null;
  const base = normEraKey(root), lower = normEraKey(file);
  if (!lower.startsWith(base + "/")) return null;
  const parts = lower.slice(base.length + 1).split("/");
  if (!parts[0] || !parts[1]) return null;
  // normEraKey only lower-cases and rewrites separators, so the same offsets carry the original case.
  const cased = file.replace(/\\/g, "/").replace(/\/+$/, "").slice(base.length + 1).split("/");
  return { key: `${parts[0]}/${parts[1]}`, provider: normEraVendor(parts[0]), name: cased[1] ?? null };
}

export const archiveSourceKey = (file: string | null | undefined, root: string): string | null =>
  archiveFolderOf(file, root)?.key ?? null;

/**
 * The source of a Codex home. A home inside the archive is its own folder. A local profile
 * directory is a copy of the folder `accounts.json` declares for it (`source_home` ↔ `home`),
 * measured 22.09: every one of the 9 424 local paths has its twin in `codex/EXAMPLE-MAIN-sample_a`.
 * A local directory with no declaration, or with two that disagree, has no source: its rows stay
 * explicitly uncertain rather than silently assigned.
 */
export function codexHomeSource(home: string | null | undefined, declarations: readonly SourceDeclaration[], root: string, machine = MACHINE): string | null {
  const direct = archiveSourceKey(home, root);
  if (direct) return direct;
  const local = normEraKey(home);
  if (!local) return null;
  const declared = new Set<string>();
  for (const d of declarations) {
    if (!["codex", "openai"].includes(normEraVendor(d.vendor)) || !d.source_home || normEraKey(d.source_home) !== local) continue;
    if (d.machine && normEraKey(d.machine) !== normEraKey(machine)) continue;
    const folder = archiveSourceKey(d.home, root);
    if (folder) declared.add(folder);
  }
  return declared.size === 1 ? [...declared][0]! : null;
}

/**
 * The source of a subscription row. Claude, Gemini and Grok keep the archive path of the
 * conversation in `path`; OpenCode (GLM) records no path, only the computer in `store`, so its
 * source is `glm/<computer>` — one source per computer, which is what the GLM plan is keyed by.
 */
export function subscriptionRowSource(adapterId: string, row: { path?: unknown; store?: unknown }, root: string): string | null {
  if (adapterId === "glm") {
    const store = typeof row.store === "string" ? row.store.trim().toLowerCase() : "";
    return store ? `glm/${store}` : null;
  }
  return archiveSourceKey(typeof row.path === "string" ? row.path : null, root);
}
