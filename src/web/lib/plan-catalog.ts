import type { PlansCatalog } from "./api/settings";

let current: PlansCatalog | null = null;
let serialized = "null";
const listeners = new Set<() => void>();

/** The active server catalog, also used by calculations; never a second bundled catalog. */
export const displayPlanCatalog = () => current;
export function publishDisplayPlanCatalog(catalog: PlansCatalog | null): void {
  if (catalog !== null && !Array.isArray(catalog?.provider_groups)) throw new Error("Invalid plan catalog response");
  const next = JSON.stringify(catalog);
  if (next === serialized) return;
  serialized = next;
  current = catalog;
  for (const listener of listeners) listener();
}
export function subscribeDisplayPlanCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
