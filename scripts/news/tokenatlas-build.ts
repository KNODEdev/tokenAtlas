import type { RepoHistory } from "../../src/server/repo-history";
import type { ProjectCostResponse } from "../../src/server/project-cost";

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

export interface DrawerSubscription { vendor: string; label: string | null; paidUsd: number | null; paidComplete: boolean; apiUsd: number; tokens: number }
export interface DrawerSummary {
  since: string | null;
  until: string;
  paidUsd: number | null;
  paidComplete: boolean;
  apiUsd: number;
  tokens: number;
  calls: number;
  activeSeconds: number;
  subscriptions: DrawerSubscription[];
  /** The drawer's timeline: API value per subscription key ("vendor:letter", "vendor:?" when unidentified) and active time, per UTC week. */
  weeks: Array<{ week: string; apiUsd: number; bySub: Record<string, number>; activeSeconds: number }>;
}

/** The project drawer's all-time summary: subscription cost against API value. Accounts become per-vendor letters. */
export function publicDrawerSummary(cost: ProjectCostResponse, projectId: string, all: BuildPeriod, weekly: RepoHistory): DrawerSummary {
  const subject = cost.subjects.find(item => item.kind === "project" && item.id === projectId);
  if (!subject || cost.since != null) throw new Error("Expected the selected project's all-time cost");
  const vendorOf = new Map(cost.subscriptions.map(item => [item.id, item.vendor]));
  const rows = Object.entries(subject.subscriptions).map(([id, slice]) => {
    const vendor = vendorOf.get(id) ?? (id.startsWith("codex") ? "codex" : id.startsWith("claude") ? "claude" : null);
    if (!vendor || !["codex", "claude", "opencode", "grok", "glm"].includes(vendor)) throw new Error("Unexpected subscription vendor");
    for (const value of [slice.api_usd, slice.tokens, ...(slice.billed_usd == null ? [] : [slice.billed_usd])]) {
      if (!Number.isFinite(value) || value < 0) throw new Error("Invalid subscription aggregate");
    }
    // An unidentified account ("codex?") keeps its traffic but gets no letter.
    return { id, known: !id.endsWith("?"), vendor, paidUsd: slice.billed_usd, paidComplete: slice.billed_complete !== false && slice.billed_usd != null, apiUsd: slice.api_usd, tokens: slice.tokens };
  }).filter(row => row.apiUsd > 0 || row.tokens > 0).sort((a, b) => b.apiUsd - a.apiUsd || b.tokens - a.tokens);
  const letters = new Map<string, number>(), keyOf = new Map<string, string>();
  const subscriptions = rows.map(({ id, known, ...row }) => {
    const index = known ? letters.get(row.vendor) ?? 0 : -1;
    if (known) letters.set(row.vendor, index + 1);
    keyOf.set(id, `${row.vendor}:${known ? String.fromCharCode(65 + index) : "?"}`);
    return { vendor: row.vendor, label: known ? String.fromCharCode(65 + index) : null, paidUsd: row.paidUsd, paidComplete: row.paidComplete, apiUsd: row.apiUsd, tokens: row.tokens };
  });
  for (const value of [subject.api_usd, subject.tokens, subject.calls]) if (!Number.isFinite(value) || value < 0) throw new Error("Invalid project cost");
  if (subject.billed_usd != null && (!Number.isFinite(subject.billed_usd) || subject.billed_usd < 0)) throw new Error("Invalid subscription cost");
  if (Math.abs(subscriptions.reduce((sum, row) => sum + row.apiUsd, 0) - subject.api_usd) > 0.05) throw new Error("Subscription values do not reconcile with the project");
  if (weekly.subject.kind !== "project" || weekly.subject.id !== projectId || weekly.granularity !== "week" || weekly.since != null) {
    throw new Error("Expected the selected project's all-time weekly history");
  }
  const weeks = weekly.points.map(point => {
    const bySub: Record<string, number> = {};
    for (const [id, part] of Object.entries(point.by_sub)) {
      if (!Number.isFinite(part.api_usd) || part.api_usd < 0) throw new Error("Invalid weekly value");
      if (!part.api_usd) continue;
      // A subscription outside the all-time report (new since it was read) stays unidentified rather than unlabelled.
      const vendor = vendorOf.get(id) ?? (id.startsWith("codex") ? "codex" : id.startsWith("claude") ? "claude" : null);
      if (!vendor) throw new Error("Unexpected weekly subscription");
      const key = keyOf.get(id) ?? `${vendor}:?`;
      bySub[key] = Math.round(((bySub[key] ?? 0) + part.api_usd) * 100) / 100;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.bucket) || !Number.isFinite(point.active_seconds) || point.active_seconds < 0) throw new Error("Invalid weekly bucket");
    return { week: point.bucket, apiUsd: point.api_usd, bySub, activeSeconds: Math.round(point.active_seconds) };
  });
  return {
    since: all.since, until: all.until, paidUsd: subject.billed_usd, paidComplete: subject.billed_complete === true,
    apiUsd: subject.api_usd, tokens: subject.tokens, calls: subject.calls, activeSeconds: all.activeSeconds, subscriptions, weeks,
  };
}
