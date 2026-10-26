import { CONTEXT_RESPONSE_PATHS } from "../../shared/context-preview";

type Loader = (signal: AbortSignal) => Promise<unknown>;
const companions = new WeakMap<object, Loader>();
const paths = new WeakMap<object, string>();
const owned=new WeakSet<object>();
export const isContextCompanionOwned=(value:unknown)=>!!value&&typeof value==="object"&&owned.has(value);

/** Transport metadata only: default response objects and their JSON stay unchanged. */
export function registerContextCompanion(body: unknown, url: URL, load: Loader): void {
  if(body&&typeof body==="object"){
    if(url.pathname==="/api/billing-cycles"){
      const accounts=(body as any).accounts??[body];for(const account of accounts)for(const cycle of account.cycles??[])owned.add(cycle);
    }else if(url.pathname==="/api/subscription-rate")for(const window of (body as any).windows??[])owned.add(window);
  }
  if(url.pathname==="/api/plan-capacity"&&!["codex","openai"].includes(url.searchParams.get("provider")??""))return;
  // Subject pickers share the history route but have no monetary report to preview.
  if (url.pathname === "/api/repo-history" && !url.searchParams.has("project") && !url.searchParams.has("repo")) return;
  if (body && typeof body === "object" && CONTEXT_RESPONSE_PATHS.has(url.pathname) && url.searchParams.get("context") !== "1")
    { companions.set(body, load); paths.set(body, url.pathname); }
}
function children(value: object): [string, unknown][] {
  return value instanceof Map ? [...value.entries()] : Object.entries(value).filter(([key]) => Array.isArray(value) || ["value", "data", "payload", "report", "samples"].includes(key));
}
export function hasContextCompanion(body: unknown): boolean {
  return !!body && typeof body === "object" && (companions.has(body) || children(body).some(([, child]) => hasContextCompanion(child)));
}
export function hasContextCompanionPath(body: unknown, path: string): boolean {
  return !!body && typeof body === "object" && (paths.get(body) === path || children(body).some(([, child]) => hasContextCompanionPath(child, path)));
}
/** Preserve tuple/envelope identity outside supported reports; never walk a report's event rows. */
export async function readContextCompanion<T>(body: T, signal: AbortSignal): Promise<T> {
  if (!body || typeof body !== "object") return body;
  const load = companions.get(body);
  if (load) return await load(signal) as T;
  const entries = await Promise.all(children(body).map(async ([key, child]) => [key, await readContextCompanion(child, signal)] as const));
  if (!entries.some(([key, value]) => value !== (body as Record<string, unknown>)[key])) return body;
  return (body instanceof Map ? new Map(entries) : Array.isArray(body) ? entries.map(([, value]) => value) : { ...body, ...Object.fromEntries(entries) }) as T;
}
