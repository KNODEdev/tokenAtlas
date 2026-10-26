export type SourceHealthStatus = "current" | "older" | "missing-assignment" | "no-sessions" | "error" | "history" | "unknown" | "configured";

export interface SourceHealthRow {
  key: string;
  subscription: string;
  vendor: string;
  label: string;
  machine: string | null;
  profile: string | null;
  archive: string | null;
  configured: boolean;
  historical: boolean;
  local: boolean;
  last_session: string | null;
  last_meter: string | null;
  last_attempt: string | null;
  error: string | null;
  status: SourceHealthStatus;
  activity_pending?: boolean;
}

export interface SourceHealthResponse {
  generated_at: string;
  local_machine: string;
  older_after_hours: number;
  activity_pending?: boolean;
  sources: SourceHealthRow[];
}

export interface SourceProfileDeclaration {
  vendor: string;
  machine?: string;
  login?: string;
  home: string;
  source_home?: string;
}

export interface SourceDetectedProfile { vendor: string; home: string; name: string; account: string | null; kind: "folder" | "managed"; error: string | null; }
export interface SourceProfileConfiguration {
  detected_profiles?: SourceDetectedProfile[];
  inventory?: SourceHealthResponse;
  revision: string;
  machine: string;
  login: string;
  declarations: SourceProfileDeclaration[];
  resolved: Array<{ archive: string; profile: string | null }>;
}

export interface SourceProfileEdit {
  revision: string;
  /** null adds a source; an index edits only that declaration. */
  index: number | null;
  subscription: string;
  vendor: string;
  profile: string;
  archive: string;
}
