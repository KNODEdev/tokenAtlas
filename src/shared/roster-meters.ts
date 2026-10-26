/** Committed percentage facts, independent of token, price and capacity calculations. */
export interface RosterMeter {
  window_id: string;
  counter: string;
  window_start: string;
  reset_at: string;
  measured_at: string;
  percent: number;
  baseline_percent: number | null;
  elapsed_percent: number;
  remaining_hours: number;
}
export interface ClaudeRosterMeters {
  weekly: RosterMeter | null;
  session: RosterMeter | null;
}
