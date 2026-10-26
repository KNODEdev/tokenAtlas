import type { Database } from "bun:sqlite";
export type ProviderId = "claude" | "codex" | "glm" | "gemini" | "grok";
export interface ProbeCapabilities {
  reportsPercent: "used" | "remaining" | "both";
  reportsAllowance: boolean;
  unit: string | null;
  windows: "single" | "multiple" | "model-family";
  targetConcurrency: "parallel" | "sequential";
}
export interface WindowReading {
  kind: string;
  group: string | null;
  scope: string | null;
  plan: string | null;
  reportedPercentSide: "used" | "remaining";
  usedPercent: number | null;
  remainingPercent: number | null;
  allowance: number | null;
  used: number | null;
  remaining: number | null;
  vendorPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  rateLimitReached: boolean | null;
  resetCredits: number | null;
  profile: string | null;
  ok: boolean | null;
  error: string | null;
  extra: Record<string, string | number | boolean | null> | null;
}
export interface ProbeError {
  account: string;
  error: string;
}
export interface ProbeCycleOptions {
  onError?: (error: ProbeError) => void;
}
export interface CredentialsResult<TCredentials> {
  creds: TCredentials | null;
  error: string | null;
}
export interface ProbeHttpResponse<TBody> {
  ok: boolean;
  status: number;
  body: TBody | null;
  /** The `Retry-After` header of a refused request, as sent. */
  retryAfter?: string | null;
}
export type ProbeFetch = <TBody>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
) => Promise<ProbeHttpResponse<TBody>>;
export interface ProbeRequestContext<TCredentials> {
  credentials: TCredentials;
  fetchJson: ProbeFetch;
}
export interface ParsedProbe<TReading extends WindowReading, TMeta> {
  readings: TReading[];
  meta: TMeta;
}
export interface ProbePersistContext<TTarget, TCredentials, TMeta> {
  target: TTarget;
  credentials: TCredentials;
  ts: string;
  meta: TMeta;
}
export interface ProbeFailureContext<TTarget> {
  target: TTarget;
  ts: string;
  error: string;
}
export interface ProviderProbeAdapter<
  TTarget,
  TCredentials,
  TRaw,
  TReading extends WindowReading,
  TMeta,
  TSample = never,
> {
  id: ProviderId;
  capabilities: ProbeCapabilities;
  subject(target: TTarget): string;
  credentials(target: TTarget): CredentialsResult<TCredentials>;
  request(target: TTarget, context: ProbeRequestContext<TCredentials>): Promise<TRaw>;
  parse(raw: TRaw): ParsedProbe<TReading, TMeta>;
  validate?(parsed: ParsedProbe<TReading, TMeta>): string | null;
  persist(
    sqlite: Database,
    readings: TReading[],
    context: ProbePersistContext<TTarget, TCredentials, TMeta>
  ): number;
  persistError?(sqlite: Database, context: ProbeFailureContext<TTarget>): number;
  read?(sqlite: Database, subject: string): TSample[];
}
export interface ProbeOutcome<TTarget, TReading extends WindowReading, TMeta> {
  target: TTarget;
  ts: string;
  readings: TReading[];
  meta: TMeta | null;
  rows: number;
  error: string | null;
}
export interface ProbeCycleResult<TTarget, TReading extends WindowReading, TMeta> {
  ts: string;
  probed: number;
  rows: number;
  errors: ProbeError[];
  outcomes: Array<ProbeOutcome<TTarget, TReading, TMeta>>;
}
export class ProviderProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProbeError";
  }
}
