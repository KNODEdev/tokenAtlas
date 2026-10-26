import { useSyncExternalStore } from "react";
import { displayPlanCatalog, subscribeDisplayPlanCatalog } from "./plan-catalog";

export function usePlanCatalog() {
  return useSyncExternalStore(subscribeDisplayPlanCatalog, displayPlanCatalog, displayPlanCatalog);
}
