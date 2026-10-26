export interface DataSettingsTarget {
  returnScreen?: "capacity" | "models" | "model-traffic" | "periods";
  area: "rates" | "subscriptions" | "periods" | "data" | "cadence" | "windows";
  account: string;
  cycle?: { start: string; end: string };
  since?: string;
  until?: string;
  model?: string;
  basis?: "chatgpt_credits" | "api_equivalent_usd";
  speed?: "standard" | "fast";
  issue?: string;
  /** Open a new price period for `model` from `since` right away (a model without a price in the rate table). */
  newPeriod?: true;
  returnRange?: { since: string; until: string; counter?: string; reference_day?: string; price_cycles?: { first: string; second: string }; quality?: "all" | "comparable" | "partial" | "insufficient" };
}
