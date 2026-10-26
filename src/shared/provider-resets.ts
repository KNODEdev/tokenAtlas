import catalog from "../../config/provider-resets.json";

/**
 * Shared provider announcements (docs/reset-capacity-plan-2026-10-11.md, appendix A).
 * Evidence for classifying a window's end, never proof that an account received a reset.
 * The repository JSON is bundled independently of private CONFIG_ROOT settings.
 */
export const PROVIDER_RESETS_VERIFIED_AT = catalog.verified_at;
export type ProviderResetKind = "reset" | "banked";
export interface ProviderReset {
  id: string;
  /** The `limit_windows.provider` it applies to. */
  provider: "codex" | "claude";
  /** UTC instant (for an approximate entry: the best guess). */
  at: string;
  kind: ProviderResetKind;
  approximate: boolean;
  source: string;
  note?: string;
}
export const PROVIDER_RESETS = catalog.resets as readonly ProviderReset[];
