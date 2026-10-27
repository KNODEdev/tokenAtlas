import type { RepoHistory } from "../../src/server/repo-history";

export interface BuildPeriod {
  since: string | null;
  until: string;
  apiUsd: number;
  apiComplete: boolean;
  allocatedUsd: number | null;
  allocatedComplete: boolean;
  tokens: number;
  calls: number;
  activeSeconds: number;
  models: Array<{ provider: string; model: string | null; tokens: number; calls: number }>;
}

/** Publish only the owner's explicitly selected project and aggregate model usage. */
export function publicBuildPeriod(history: RepoHistory, projectId: string, until: string): BuildPeriod {
  if (history.subject.kind !== "project" || history.subject.id !== projectId || history.by !== "model") {
    throw new Error("Expected the selected project's model history");
  }
  const models = new Map<string, BuildPeriod["models"][number]>();
  for (const point of history.points) for (const [key, part] of Object.entries(point.split ?? {})) {
    for (const value of [part.tokens, part.calls]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid model usage");
    if (!part.tokens && !part.calls) continue;
    const slash = key.indexOf("/"), provider = key.slice(0, slash), model = key.slice(slash + 1);
    if (!["codex", "claude", "opencode", "grok", "glm"].includes(provider)) throw new Error("Unexpected model provider");
    // A malformed identifier remains unknown; never export paths or free-form source text.
    const safeModel = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model) ? model : null;
    const safeKey = `${provider}/${safeModel ?? "?"}`;
    const row = models.get(safeKey) ?? { provider, model: safeModel, tokens: 0, calls: 0 };
    row.tokens += part.tokens; row.calls += part.calls;
    models.set(safeKey, row);
  }
  const rows = [...models.values()].sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider) || (a.model ?? "").localeCompare(b.model ?? ""));
  const totals = history.totals;
  for (const value of [totals.tokens, totals.calls]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid project usage");
  if (rows.reduce((sum, row) => sum + row.tokens, 0) !== totals.tokens || rows.reduce((sum, row) => sum + row.calls, 0) !== totals.calls) {
    throw new Error("Model usage does not reconcile with project totals");
  }
  for (const value of [totals.api_usd, totals.tokens, totals.calls, totals.active_seconds, ...rows.flatMap(row => [row.tokens, row.calls])]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid project aggregate");
  }
  if (totals.billed_usd !== null && (!Number.isFinite(totals.billed_usd) || totals.billed_usd < 0)) throw new Error("Invalid allocated cost");
  return {
    since: history.since ?? history.points[0]?.bucket ?? null, until,
    apiUsd: totals.api_usd, apiComplete: totals.api_complete === true,
    allocatedUsd: totals.billed_usd, allocatedComplete: totals.billed_complete === true,
    tokens: totals.tokens, calls: totals.calls, activeSeconds: totals.active_seconds, models: rows,
  };
}
