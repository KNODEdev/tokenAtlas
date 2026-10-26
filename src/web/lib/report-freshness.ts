import { useSyncExternalStore } from "react";

const preparedTimes = new WeakMap<object, number>();
const signalTimes = new WeakMap<AbortSignal, number>();
const visible = new Map<string, number>();
const listeners = new Set<() => void>();
let oldest: number | null = null;

export function markReportStale(body: unknown, preparedAt: number, signal?:AbortSignal): void {
  if(body && typeof body === "object" && Number.isFinite(preparedAt))preparedTimes.set(body,preparedAt);
  if(signal && Number.isFinite(preparedAt))signalTimes.set(signal,Math.min(signalTimes.get(signal)??preparedAt,preparedAt));
}
export const staleSignalTime=(signal:AbortSignal):number|null=>signalTimes.get(signal)??null;
export function staleReportTime(body: unknown): number | null {
  return body && typeof body === "object" ? preparedTimes.get(body) ?? null : null;
}
export function visibleReportFreshness(id:string, preparedAt:number|null):void {
  if(preparedAt===null)visible.delete(id);else visible.set(id,preparedAt);
  const next=visible.size ? Math.min(...visible.values()) : null;
  if(next===oldest)return;
  oldest=next;
  for(const listener of listeners)listener();
}
export function useStaleReportTime():number|null {
  return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>oldest,()=>null);
}
