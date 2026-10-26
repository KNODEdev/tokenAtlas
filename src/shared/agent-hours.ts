export const ACTIVE_GAP_MS = 5 * 60_000;
/** Canonical request instants from all sources of one subscription, including neighbouring instants. */
export function activeMilliseconds(instants: readonly number[], from: number, until: number): number {
  const times=[...new Set(instants.filter(Number.isFinite))].sort((a,b)=>a-b);
  let active=0;
  for(let i=1;i<times.length;i++) {
    const a=times[i-1]!,b=times[i]!;
    if(b-a<=ACTIVE_GAP_MS) active+=Math.max(0,Math.min(b,until)-Math.max(a,from));
  }
  return active;
}
export function hoursPer100(activeMs:number,pp:number|null):number|null {
  return pp!==null && Number.isFinite(pp) && pp>=20 ? activeMs/3_600_000/(pp/100) : null;
}
