import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiReadsAffected, bustApiMemo, onApiRefresh, trackApiReads } from "./api";
import { markReportStale, staleReportTime, staleSignalTime, visibleReportFreshness } from "./report-freshness";
import { useContextCompanion } from "./use-context-companion";
export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}
const retainedViews = new Map<string, unknown>();
/**
 * The last data each hook instance read for each of its dependency sets: returning to an account or window
 * shows what it showed before while the request runs again (never another scope's data).
 */
const lastSeen = new Map<string, unknown>();
const LAST_SEEN_MAX = 96;
const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
/** Primitives by value, objects by identity: a key costs nothing even for a dependency holding a whole model. */
function dependencyKey(value: unknown): string {
  if (value === null || typeof value !== "object" && typeof value !== "function") return `${typeof value}:${String(value)}`;
  let id = objectIds.get(value as object);
  if (id === undefined) { id = ++nextObjectId; objectIds.set(value as object, id); }
  return `#${id}`;
}
function scopeKeyOf(id: string, retainKey: string | undefined, deps: unknown[]): string {
  return [id, retainKey ?? "", ...deps.map(dependencyKey)].join("\u0000");
}
function rememberSeen(key: string, data: unknown) {
  lastSeen.delete(key); lastSeen.set(key, data);
  if (lastSeen.size > LAST_SEEN_MAX) lastSeen.delete(lastSeen.keys().next().value!);
}
const sameDependencies = (before:unknown[],after:unknown[]) => before.length===after.length && before.every((value,index)=>Object.is(value,after[index]));
export function useAsync<T>(fn: (signal:AbortSignal) => Promise<T>, deps: unknown[], live = false, retainKey?: string): AsyncState<T> {
  const [result, setResult] = useState<{data:T|null;error:string|null;deps:unknown[];retainKey?:string}>(() => ({
    data:retainKey ? retainedViews.get(retainKey) as T ?? null : null,error:null,deps:[...deps],retainKey,
  }));
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const id=useId();
  const readSignal=useRef<AbortSignal|null>(null);
  const scopeKey=scopeKeyOf(id,retainKey,deps);
  useEffect(() => onApiRefresh(change => {
    if(apiReadsAffected(readSignal.current,change,live))setNonce((value) => value + 1);
  }, live), [live]);
  useEffect(() => {
    let alive = true;
    const controller=new AbortController();
    readSignal.current=controller.signal;
    const stopTracking=trackApiReads(controller.signal);
    setLoading(true);
    fn(controller.signal)
      .then((d) => {
        if (!alive) return;
        const staleAt=staleSignalTime(controller.signal);
        if(staleAt!==null)markReportStale(d,staleAt);
        if (retainKey) retainedViews.set(retainKey, d);
        rememberSeen(scopeKey, d);
        setResult({data:d,error:null,deps:[...deps],retainKey});
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setResult(previous=>({
          data:previous.retainKey===retainKey && sameDependencies(previous.deps,deps)?previous.data:null,
          error:e instanceof Error ? e.message : String(e),deps:[...deps],retainKey,
        }));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      stopTracking();
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, retainKey]);
  const reload = useCallback(() => {
    bustApiMemo();
    setNonce((n) => n + 1);
  }, []);
  // Preserve a ready report on refresh, but never label another account/filter's data as current.
  const sameScope=result.retainKey===retainKey && sameDependencies(result.deps,deps);
  const staleAt=sameScope ? staleReportTime(result.data) : null;
  useEffect(()=>{
    visibleReportFreshness(id,staleAt);
    if(staleAt===null)return;
    const timer=setInterval(()=>setNonce(n=>n+1),2000);
    return()=>{clearInterval(timer);visibleReportFreshness(id,null);};
  },[id,staleAt]);
  // Back on a scope read before: its last data stays visible until the new request answers.
  const seen=!sameScope ? lastSeen.get(scopeKey) as T | undefined : undefined;
  const raw = sameScope ? result.data : seen ?? null;
  const preview = useContextCompanion(raw);
  return { data: preview.data, error: (sameScope ? result.error : null) ?? preview.error,
    loading: loading || !sameScope || preview.loading, reload };
}
