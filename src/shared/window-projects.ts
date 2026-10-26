import type { ContextPreviewResponse } from "./context-preview";
export interface WindowProjectMeasures {
  calls: number;
  tokens: number;
  /** Priced portion only; null when no call has a price. */
  api_usd: number | null;
  unpriced_calls: number;
  invalid_calls: number;
  approximate_calls: number;
  unknown_mode_tokens: number;
}
export interface WindowProject extends WindowProjectMeasures {
  project_id: string | null;
  name: string | null;
  models: Array<WindowProjectMeasures & { model: string | null }>;
  hours: Array<{ hour: string; tokens: number; calls: number }>;
}
export interface WindowProjectsResponse extends ContextPreviewResponse<WindowProjectsResponse> {
  account: string;
  provider: string;
  from: string;
  /** Exclusive, including for a closed window. */
  until: string;
  projects: WindowProject[];
}
