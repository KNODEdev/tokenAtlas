import type { DataSettingsTarget } from "./data-settings";

/** The three Settings tabs (user decision 2026-10-08): accounts, computers and data, price lists. */
export type SettingsTab = "accounts" | "computers" | "pricing";
/**
 * What another screen may ask for: a tab, or one of the areas the seven earlier tabs were named after. Each
 * area still names a place: the tab, the open account section or the price-list view it now lives in.
 */
export type SettingsRequest = SettingsTab | "sources" | DataSettingsTarget["area"] | "plans";
export type AccountSettingsSection = "price" | "promotions" | "rhythm" | "windows";
export interface SettingsPlace {
  tab: SettingsTab;
  /** Accounts: the per-account sections to open. */
  sections?: AccountSettingsSection[];
  /** Price lists: Plans or Models. */
  pricing?: "plans" | "models";
  /** Computers and data: bring the data section into view. */
  data?: true;
}

export function settingsPlace(request: SettingsRequest): SettingsPlace {
  switch (request) {
    case "accounts": case "periods": return { tab: "accounts" };
    // The old Subscriptions tab held the price table and the promotions editor of the linked subscription.
    case "subscriptions": return { tab: "accounts", sections: ["price", "promotions"] };
    case "cadence": return { tab: "accounts", sections: ["rhythm"] };
    case "windows": return { tab: "accounts", sections: ["windows"] };
    case "computers": case "sources": return { tab: "computers" };
    case "data": return { tab: "computers", data: true };
    case "pricing": case "plans": return { tab: "pricing", pricing: "plans" };
    case "rates": return { tab: "pricing", pricing: "models" };
  }
}

/**
 * The Settings place another screen asked for (Data sources' checks link to Profiles, Account periods and
 * Models and rates). App keeps no tab state, so Settings reads the request when it opens.
 */
let requested: SettingsRequest | null = null;

export function requestSettingsTab(request: SettingsRequest): void {
  requested = request;
}

/** The pending request without clearing it: the first render must already show that tab. */
export function peekSettingsTab(): SettingsRequest | null {
  return requested;
}

export function takeSettingsTab(): SettingsRequest | null {
  const request = requested;
  requested = null;
  return request;
}
