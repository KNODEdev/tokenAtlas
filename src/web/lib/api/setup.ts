

export interface SuggestedSubscription {
  id: string;
  vendor: string;
  machine: string;
  login: string;
  home: string;
  source_home?: string;
  account?: string;
  from?: string;
  until?: string;
  note?: string;
  found_in: "archive" | "live" | "declared";
  is_this_machine: boolean;
  merged_from_login: boolean;
}
export interface SetupState {
  profiles?: Array<{ vendor: string; home: string; account: string | null; error: string | null }>;
  configured: boolean;
  reason: string | null;
  machine: string;
  login: string;
  profile: string;
  /** The user's home folder; the screens shorten paths under it to `~`. */
  home?: string;
  archive: {
    root: string;
    explicit: boolean;
    exists: boolean;
    /** missing / empty: one click creates the archive there; other: unknown files, never written on its own. */
    kind?: "missing" | "empty" | "archive" | "other";
    vendors: Array<{ vendor: string; profiles: string[] }>;
  };
  config: {
    root: string;
    explicit: boolean;
    exists: boolean;
    present: string[];
    missing: string[];
    conflicts: string[];
  };
  snapshot: {
    root: string;
    explicit: boolean;
    exists: boolean;
    database: string;
  };
  temporary?: { root: string; exists: boolean };
  live: Array<{ vendor: string; path: string; exists: boolean }>;
  suggestion: SuggestedSubscription[];
  notes: string[];
}
export interface SetupSaveRequest {
  archive?: string | null;
  archiveAction?: "create" | "connect";
  config?: string | null;
  snapshot?: string | null;
  sources?: Array<{ vendor: string; machine?: string; login?: string; home: string; source_home?: string }>;
  subscriptions: Array<{
    id: string;
    vendor?: string;
    machine?: string;
    login?: string;
    home: string;
    source_home?: string;
    account?: string;
    from?: string;
    until?: string;
    note?: string;
  }>;
}
export interface SetupSaveResponse {
  ok: true;
  wrote: string[];
  restart_required: boolean;
  restart_reason: string | null;
  state: SetupState;
}
export interface HealthUnpricedItem {
  model: string;
  observed_provider: string;
  rate_vendor: string | null;
  tokens: number;
  /** `missing_rate` (priceable in Settings) or `no_rate_card` (the vendor has no rate card). */
  reason: string;
  /** The first UTC day of such a call. */
  first_day?: string;
}
/** Latest identity observed for one probe source (`/api/health.identity`). */
export interface IdentitySource {
  vendor: string;
  /** CODEX_HOME, subscription id or pool-account id — whatever the probe reports. */
  source: string;
  subscription_id: string | null;
  identity_kind: string;
  identity: string;
  /** `account` declared on the subscription entry, already trimmed by the server. */
  declared: string | null;
  raw_source: string | null;
  ts: string;
  /** PC that observed the credentials; null for rows older than the cross-machine journal. */
  machine: string | null;
}
/**
 * Server-built warning. `kind` is open on purpose: the UI renders an unknown kind
 * with the generic template instead of dropping it.
 */
export interface IdentityWarning {
  kind: string;
  vendor: string;
  subscription_id: string | null;
  source: string;
  observed: string | null;
  declared: string | null;
  ts: string;
  hint: string;
}
export interface IdentityReport {
  sources: IdentitySource[];
  warnings: IdentityWarning[];
}
export interface HealthResponse {
  ok?: boolean;
  identity?: IdentityReport;
  unpriced?: {
    tokens: number;
    items?: HealthUnpricedItem[];
    models?: Record<string, { tokens: number; reason: string; observed_provider?: string; rate_vendor?: string | null }>;
  };
  [k: string]: unknown;
}
