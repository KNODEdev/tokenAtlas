/** A paired presentation folded from the same saved facts; optional for older servers and unfinished projections. */
export interface ContextPreviewStatus { ready: boolean; revision: number; missing_groups: number }
export interface ContextPreviewResponse<T> { context_preview?: T; context_preview_status?: ContextPreviewStatus }
export const CONTEXT_RESPONSE_PATHS = new Set(["/api/global-usage", "/api/account-history", "/api/summary", "/api/breakdown",
  "/api/events", "/api/project-cost", "/api/repo-history", "/api/window-projects", "/api/codex-accounting",
  "/api/cycle-breakdown", "/api/model-capacity", "/api/model-usage-share", "/api/project-plan", "/api/billing-cycles", "/api/plan-capacity", "/api/subscription-rate"]);

const selected = new WeakMap<object, unknown>();
const presentations = new WeakSet<object>();
export const isContextPreviewSelected = (value: unknown): boolean => !!value && typeof value === "object" && presentations.has(value);
/** Immutable, local selection, including reports inside Promise.all tuples or a mutation-generation envelope. */
export function responseWithContextPreview<T>(value: T, on: boolean): T {
  if (!on || value === null || typeof value !== "object") return value;
  if (selected.has(value)) return selected.get(value) as T;
  if(value instanceof Map){const entries=[...value].map(([key,child])=>[key,responseWithContextPreview(child,true)] as const);
    const result=entries.some(([key,child])=>child!==value.get(key))?new Map(entries):value;selected.set(value,result);return result as T;}
  const paired = value as ContextPreviewResponse<T>;
  if (paired.context_preview !== undefined && paired.context_preview_status?.ready && paired.context_preview_status.missing_groups === 0) {
    if (paired.context_preview && typeof paired.context_preview === "object") {
      const mark=(value:object)=>{if(presentations.has(value))return;presentations.add(value);for(const child of Object.values(value))if(child&&typeof child==="object")mark(child);};
      mark(paired.context_preview);
    }
    selected.set(value, paired.context_preview); return paired.context_preview;
  }
  let changed = false;
  const entries = Object.entries(value).map(([key, child]) => {
    // Never walk the alternative again, or treat projection metadata as a nested report.
    const next = key.startsWith("context_preview") ? child : responseWithContextPreview(child, true);
    changed ||= next !== child; return [key, next] as const;
  });
  const result = changed ? Array.isArray(value) ? entries.map(([, child]) => child) : Object.fromEntries(entries) : value;
  selected.set(value, result);
  return result as T;
}
