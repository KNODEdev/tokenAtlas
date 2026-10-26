/** Runtime-neutral P0/P1 contract; no dependency on Bun or history DTOs. */
export type SubscriptionLifecycle = "active" | "paused" | "cancelled" | "unknown";
export type CurrentStatus = "initializing" | "ready" | "updating" | "error";
export type LimitFreshness = "fresh" | "stale" | "expired" | "clock-skew" | "conflict";
export interface SubscriptionDeclaration {
  id: string;
  vendor: string;
  label?: string;
  account?: string | null;
  account_key?: string;
  note?: string;
  status?: SubscriptionLifecycle;
}
export interface CurrentIdentity {
  id: string;
  vendor: string;
  label: string;
  account_identity: string | null;
  identity_basis: "declared" | "unknown";
  lifecycle: SubscriptionLifecycle;
  binding_active: boolean;
  declaration_conflict: boolean;
}
export interface CurrentProbeError {
  measured_at: string;
  machine: string | null;
  code: "probe-failed";
}
export interface CurrentLimit {
  key: string;
  kind: string;
  group: string | null;
  scope: string | null;
  window_minutes: number | null;
  plan: string | null;
  measured_at: string;
  machine: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  used: number | null;
  remaining: number | null;
  allowance: number | null;
  resets_at: string | null;
  rate_limit_reached: boolean | null;
  basis: "measured";
  age_minutes: number;
  freshness: LimitFreshness;
}
export interface CurrentSubscription extends CurrentIdentity {
  limits: CurrentLimit[];
  latest_error: CurrentProbeError | null;
  clock_warning: boolean;
  limits_truncated: boolean;
}
export interface CurrentRevisions {
  probes: number;
  published_probes: number;
  configuration: string;
}
export interface CurrentEnvelope<T> {
  schema_version: 1;
  generation: number;
  source_revisions: CurrentRevisions;
  generated_at: string | null;
  /** Unknown completeness is not replaced by the newest sample timestamp. */
  coverage_through: null;
  status: CurrentStatus;
  updating: boolean;
  error_code: string | null;
  data: T;
}
export interface BootstrapData {
  subscriptions: CurrentSubscription[];
  default_context: "all";
  configured: boolean;
}
export type BootstrapSnapshot = CurrentEnvelope<BootstrapData>;
