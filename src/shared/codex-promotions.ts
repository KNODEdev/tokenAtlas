import catalog from "../../config/codex-promotions.json";

// Shared announcements are bundled with the app, independently of private CONFIG_ROOT settings.
export const CODEX_PROMOTIONS_VERIFIED_AT = catalog.verified_at;
export interface CodexPromotion {
  id: string;
  announced: string;
  announced_at?: string;
  until: string | null;
  kind: "allowance" | "reset" | "window" | "discount" | "price" | "policy";
  factor: number | null;
  plans: readonly string[];
  plan_id?: string;
  window_kind?: string;
  source: string;
  official_sources?: readonly { url: string; label: { en: string; pl: string } }[];
  title: { en: string; pl: string };
  detail: { en: string; pl: string };
}
export const CODEX_PROMOTIONS = catalog.promotions as readonly CodexPromotion[];

const launch = CODEX_PROMOTIONS.find(p => p.id === "codex-pro-100-launch-2026");
if (!launch || launch.kind !== "allowance" || launch.until === null || launch.factor === null) {
  throw new Error("The shipped Codex catalog must contain the bounded Pro 100 USD launch allowance");
}
export const CODEX_PRO_5X_LAUNCH_PROMOTION: CodexPromotion & { until: string; factor: number } = {
  ...launch, until: launch.until, factor: launch.factor,
};

export type CapacityBasis = "observed" | "regular";
export interface CyclePromotion {
  status: "configured" | "unknown" | "mixed" | "uncertain" | "invalid";
  factor: number | null;
  regime_ids: string[];
  notes: string[];
  sources: string[];
}
