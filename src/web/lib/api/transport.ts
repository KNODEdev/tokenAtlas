import { registerContextCompanion } from "../context-companion";
import type { ApiRefresh } from "../../../shared/read-refresh";
import { cycleReadBatch } from "../cycle-read-batch";
import { preparedResponse } from "../prepared-response";
import { assertPrivacyWriteAllowed, learnPrivacyIdentities } from "../privacy";
import { markReportStale, staleReportTime } from "../report-freshness";
import type { VendorId } from "./accounts";
import type { AtlasSnapshotStatus } from "./sync";

export class ApiError extends Error {
  /** `reason`: a refusal's machine-readable cause when the route gives one (`{ error, reason }`). */
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
    this.name = "ApiError";
  }
}
const GET_MEMO_TTL_MS = 30_000;
const GET_MEMO_SKIP = new Set(["/api/sync", "/api/health", "/api/index-snapshot", "/api/source-folders", "/api/claude-login"]);
// These reads use configuration or traffic totals, never live percentage readings.
const READINGS_INDEPENDENT_GETS = new Set(["/api/projects", "/api/rate-cards", "/api/plans-catalog", "/api/setup"]);
interface MemoRead {
  t: number; p: Promise<unknown>; settled: boolean; controller: AbortController;
  waiters: number; unscoped: boolean;
}
const getMemo = new Map<string, MemoRead>();
const apiRefreshListeners = new Set<(change?: ApiRefresh) => void>();
const liveApiRefreshListeners = new Set<(change?: ApiRefresh) => void>();
const activeReads = new Map<AbortSignal, Set<string>>();
export function trackApiReads(signal: AbortSignal): () => void {
  activeReads.set(signal, new Set());
  return () => { activeReads.delete(signal); };
}
const requestPath = (url: URL) => url.pathname + url.search;
export function apiReadsAffected(signal: AbortSignal | null, change?: ApiRefresh, live = false): boolean {
  const paths = signal && activeReads.get(signal);
  return !change || live && change.live === true || !paths?.size || [...paths].some(path => !change.unchanged.includes(path));
}
export function readRefreshPaths(): string {
  const paths = new Set([...activeReads.values()].flatMap(paths => [...paths]));
  for (const key of getMemo.keys()) paths.add(requestPath(new URL(key)));
  // Unlisted readers take the conservative full-refresh path.
  const limited: string[] = [];
  for (const path of paths) {
    if (limited.length >= 128 || new URLSearchParams({ read_paths: JSON.stringify([...limited, path]) }).toString().length > 6000) break;
    limited.push(path);
  }
  return JSON.stringify(limited);
}
export function bustApiMemo(): void {
  getMemo.clear();
}
export function onApiRefresh(listener: (change?: ApiRefresh) => void, live = false): () => void {
  apiRefreshListeners.add(listener);
  if (live) liveApiRefreshListeners.add(listener);
  return () => {
    apiRefreshListeners.delete(listener);
    liveApiRefreshListeners.delete(listener);
  };
}
export function refreshApiData(change?: ApiRefresh): void {
  if (!change) bustApiMemo();
  else for (const key of getMemo.keys()) if (!change.unchanged.includes(requestPath(new URL(key)))
    || change.live && !READINGS_INDEPENDENT_GETS.has(new URL(key).pathname)) getMemo.delete(key);
  for (const listener of apiRefreshListeners) listener(change);
}
export function refreshLiveApiData(): void {
  for (const key of getMemo.keys()) if (!READINGS_INDEPENDENT_GETS.has(new URL(key).pathname)) getMemo.delete(key);
  for (const listener of liveApiRefreshListeners) listener();
}
export function syncRequestPath(
  mode: "incremental" | "full" = "incremental",
  vendor?: VendorId
): string {
  const params = new URLSearchParams();
  if (mode === "full") params.set("mode", "full");
  if (vendor) params.set("vendor", vendor);
  const query = params.toString();
  return `/api/sync${query ? `?${query}` : ""}`;
}
export async function fetchJson<T>(url: URL, signal?: AbortSignal, batchCycle = false): Promise<T> {
  const res = await preparedResponse(url.toString(), { signal, ...(batchCycle ? { fetcher: cycleReadBatch } : {}) });
  const body = await res.json().catch(() => null);
  const preparedAt = res.headers.get("X-Analysis-Prepared-At");
  if(res.headers.get("X-Analysis")==="stale" && preparedAt !== null)markReportStale(body,Number(preparedAt),signal);
  learnPrivacyIdentities(body);
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String(body.error) : res.statusText;
    throw new ApiError(msg, res.status);
  }
  registerContextCompanion(body, url, signal => get<T>(url.pathname, { ...Object.fromEntries(url.searchParams), context: "1" }, signal));
  return body as T;
}
export function get<T>(path: string, params?: Record<string, string | number | undefined>, signal?:AbortSignal,
  options: { reuseSettled?: boolean; batchCycle?: boolean } = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (signal) activeReads.get(signal)?.add(requestPath(url));
  if (GET_MEMO_SKIP.has(url.pathname) || (url.pathname === "/api/source-profile" && url.searchParams.has("discover"))) return fetchJson<T>(url,signal);
  const key = url.toString();
  const hit = getMemo.get(key);
  // Scoped reads stay fresh unless their endpoint retains an existing completed-memo contract.
  let entry = hit && (!hit.settled || (!signal || options.reuseSettled) && Date.now() - hit.t < GET_MEMO_TTL_MS) ? hit : undefined;
  if (!entry) {
    const controller = new AbortController(), p = fetchJson<T>(url, controller.signal, options.batchCycle);
    const created: MemoRead = { t: Date.now(), p, settled: false, controller, waiters: 0, unscoped: false };
    entry = created;
    getMemo.set(key, created);
    p.then(body => { created.settled = true; created.t = staleReportTime(body)===null ? Date.now() : 0; }, () => {
      created.settled = true;
      if (getMemo.get(key) === created) getMemo.delete(key);
    });
  }
  if (getMemo.size > 128) {
    const now = Date.now();
    for (const [k, v] of getMemo) if (v.settled && now - v.t >= GET_MEMO_TTL_MS) getMemo.delete(k);
  }
  if (!signal) { entry.unscoped = true; return entry.p as Promise<T>; }
  const current = entry;
  current.waiters++;
  // The shared fetch belongs to all callers, not to the first component's signal.
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      signal.removeEventListener("abort", abort);
      current.waiters--;
      if (!current.settled && !current.unscoped && current.waiters === 0) {
        if (getMemo.get(key) === current) getMemo.delete(key);
        current.controller.abort();
      }
      return true;
    };
    const abort = () => { if (release()) reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    current.p.then(body => {
      if (!release()) return;
      const staleAt = staleReportTime(body);
      if (staleAt !== null) markReportStale(body, staleAt, signal);
      resolve(body as T);
    }, error => { if (release()) reject(error); });
  });
}
let writesInFlight = 0;
const writeListeners = new Set<(n: number) => void>();
export function onWrites(fn: (n: number) => void): () => void {
  writeListeners.add(fn);
  fn(writesInFlight);
  return () => {
    writeListeners.delete(fn);
  };
}
function noteWrites(delta: number): void {
  writesInFlight = Math.max(0, writesInFlight + delta);
  for (const fn of writeListeners) fn(writesInFlight);
}
export async function post<T>(path: string, body?: unknown): Promise<T> {
  assertPrivacyWriteAllowed();
  noteWrites(1);
  try {
    const res = await fetch(new URL(path, window.location.origin), {
      method: "POST",
      // Also without a body: the server refuses any write that is not JSON (write-guard.ts).
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    learnPrivacyIdentities(parsed);
    if (!res.ok) {
      const msg = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : res.statusText;
      const reason = parsed && typeof parsed === "object" && "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : undefined;
      throw new ApiError(msg, res.status, reason);
    }
    return parsed as T;
  } finally {
    noteWrites(-1);
    bustApiMemo();
  }
}
export async function indexSnapshotRequest(method: "GET" | "POST"): Promise<AtlasSnapshotStatus> {
  if (method === "POST") assertPrivacyWriteAllowed();
  if (method === "POST") noteWrites(1);
  try {
    const res = await fetch(new URL("/api/index-snapshot", window.location.origin),
      method === "POST" ? { method, headers: { "content-type": "application/json" } } : { method });
    const parsed = await res.json().catch(() => null);
    learnPrivacyIdentities(parsed);
    const structured =
      parsed != null &&
      typeof parsed === "object" &&
      "running" in parsed &&
      "newest_valid" in parsed &&
      "discovery_error" in parsed;
    if (!structured) {
      const msg = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : res.statusText;
      throw new ApiError(msg, res.status);
    }
    return parsed as AtlasSnapshotStatus;
  } finally {
    if (method === "POST") {
      noteWrites(-1);
      bustApiMemo();
    }
  }
}
