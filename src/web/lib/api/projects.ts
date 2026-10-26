import type { ContextPreviewResponse } from "../../../shared/context-preview";


export interface ProjectMatch {
  store?: string;
  cwd?: string;
  repo?: string;
  project?: string;
  from?: string;
  until?: string;
}
export interface ProjectAgg {
  calls: number;
  tokens: number;
  first_ts: string | null;
  last_ts: string | null;
}
export interface ApiProject extends ProjectAgg {
  id: string;
  name: string;
  note?: string;
  matches: ProjectMatch[];
  vendors: Record<string, ProjectAgg>;
}
export interface ProjectsResponse {
  projects: ApiProject[];
  unassigned: ProjectAgg & { vendors: Record<string, ProjectAgg> };
  file: string;
}
export interface UnassignedRow {
  vendor: string;
  store: string;
  /** Account ids whose dated ownership ranges overlap this row; empty for sources without an account assignment. */
  account_ids?: string[];
  cwd: string | null;
  project: string | null;
  calls: number;
  tokens: number;
  first_ts: string;
  last_ts: string;
}
export interface AssignRequest {
  match: ProjectMatch;
  project_id?: string;
  new?: { id: string; name: string };
}
export interface ReassignRequest {
  from: string;
  index?: number;
  match?: ProjectMatch;
  to?: string;
  new?: { id: string; name: string };
  drop_empty?: boolean;
}
export interface ReassignResponse {
  ok: true;
  moved: ProjectMatch[];
  from: string;
  from_dropped: boolean;
  to: string | null;
  /** Project rules apply at read time: a rule change remaps nothing. */
  remap: null;
}
export interface ProjectUpdateRequest {
  project_id: string;
  new_id?: string;
  name?: string;
  note?: string | null;
  matches?: ProjectMatch[];
  delete?: boolean;
}
export interface ProjectUpdateResponse {
  ok: true;
  project?: ApiProject;
  deleted?: string;
  /** Project rules apply at read time: a rule change remaps nothing. */
  remap: null;
}
export interface MergeRequest {
  subjects: Array<{ kind: "project" | "repo"; id: string }>;
  project_id?: string;
  new?: { id: string; name: string };
}
export interface MergeResponse {
  ok: true;
  project: { id: string; name: string; matches: ProjectMatch[] };
  absorbed: { repos: string[]; projects: string[] };
  skipped: string[];
  /** Project rules apply at read time: a rule change remaps nothing. */
  remap: null;
}
export interface RemapResult {
  rules: number;
  perTable: Record<string, { assigned: number; total: number }>;
  repoPerTable?: Record<string, { assigned: number; total: number }>;
}
export interface SubjectRow {
  kind: "project" | "repo";
  id: string;
  name: string;
  group: string | null;
  tokens: number;
  calls: number;
  active_seconds: number;
  session_seconds?: number;
  repos: string[];
}
export interface SubjectListResponse {
  idle_gap_minutes: number;
  since: string | null;
  until: string | null;
  subjects: SubjectRow[];
}
export interface RepoSplitEntry {
  tokens: number;
  calls: number;
  active_seconds: number;
}
export interface RepoBucketPoint {
  bucket: string;
  tokens: number;
  calls: number;
  active_seconds: number;
  /** active_seconds by computer ("?" when the source names none); the parts add up to it. */
  active_by_machine: Record<string, number>;
  /** Additive agent-session time: parallel sessions add up; `active_seconds` counts them once per computer. */
  session_seconds: number;
  api_usd: number;
  api_complete: boolean;
  billed_usd: number | null;
  billed_complete: boolean;
  by_sub: Record<string, { api_usd: number; billed_usd: number | null }>;
  split?: Record<string, RepoSplitEntry>;
}
export type CalendarGranularity = "day" | "week" | "month";
export interface RepoHistoryResponse extends ContextPreviewResponse<RepoHistoryResponse> {
  subject: { kind: "project" | "repo"; id: string };
  repo: string | null;
  granularity: CalendarGranularity;
  by: "none" | "vendor" | "model" | "account";
  idle_gap_minutes: number;
  since: string | null;
  until: string | null;
  vendor_coverage: Array<{ vendor: string; first: string | null; last: string | null }>;
  totals: {
    tokens: number;
    calls: number;
    active_seconds: number;
    active_by_machine: Record<string, number>;
    session_seconds: number;
    api_usd: number;
    api_complete: boolean;
    billed_usd: number | null;
    billed_complete: boolean;
    by_sub: Record<string, { api_usd: number; billed_usd: number | null }>;
  };
  points: RepoBucketPoint[];
  claude?: {
    accounts: string[];
    /** Account/range conflict counts; these are not accepted calls or project attribution. */
    conflicts?: Array<{ account: string; identities: number }>;
    unpriced: Array<{ account: string; model: string; reason: string; tokens: number; calls: number }>;
    evidence: Array<{ reason: "unverified_account" | "source_without_identity"; tokens: number; calls: number }>;
  };
  /** Canonical Grok/GLM diagnostics; evidence and conflicts are not subject totals. */
  providers?: Array<{
    provider: "grok" | "glm";
    accounts: string[];
    unpriced: Array<{ account: string; model: string; reason: string; tokens: number; calls: number }>;
    evidence: Array<{
      reason: "unmapped_account" | "ambiguous_account" | "source_without_identity";
      tokens: number;
      calls: number;
    }>;
    conflicts?: Array<{ account: string; identities: number }>;
  }>;
  notes: string[];
}
