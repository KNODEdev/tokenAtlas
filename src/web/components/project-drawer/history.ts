import { registerContextCompanion } from "../../lib/context-companion";
import type { CalendarGranularity, RepoHistoryResponse } from "../../lib/api";
import { preparedResponse } from "../../lib/prepared-response";

export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e != null && "name" in e && e.name === "AbortError";
}

export function repoHistoryUrl(request: {
  subject: { kind: "project" | "repo"; id: string };
  granularity: CalendarGranularity;
  idleGap: number;
  since?: string;
}): URL {
  const url = new URL("/api/repo-history", window.location.origin);
  if (request.subject.kind === "project") url.searchParams.set("project", request.subject.id);
  else url.searchParams.set("repo", request.subject.id);
  url.searchParams.set("granularity", request.granularity);
  url.searchParams.set("by", "none");
  url.searchParams.set("idle_gap", String(request.idleGap));
  if (request.since) url.searchParams.set("since", request.since);
  return url;
}

export async function fetchRepoHistory(url: URL, signal: AbortSignal): Promise<RepoHistoryResponse> {
  const res = await preparedResponse(url.toString(), { signal });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new Error(msg);
  }
  registerContextCompanion(body, url, signal => {
    const companion = new URL(url); companion.searchParams.set("context", "1");
    return fetchRepoHistory(companion, signal);
  });
  return body as RepoHistoryResponse;
}

export function historyForRequest(
  state: { data: RepoHistoryResponse | null; error: string | null; loading: boolean },
  request: {
    subject: { kind: "project" | "repo"; id: string };
    granularity: CalendarGranularity;
    idleGap: number;
    since?: string;
  },
): RepoHistoryResponse | null {
  const data = state.data;
  // A reload of the same request keeps the previous answer; the checks below reject another subject or range.
  if (state.error != null || data == null) return null;
  if (data.subject.kind !== request.subject.kind || data.subject.id !== request.subject.id) return null;
  if (data.granularity !== request.granularity || data.idle_gap_minutes !== request.idleGap) return null;
  return (data.since ?? null) === (request.since ?? null) ? data : null;
}
