import type { JournalDeliveryError } from "./journal";

export interface GaugeJournalDeliveryStatus {
  /** Whether this process delivers its journal (the background writer runs the delivery job). */
  running: boolean;
  lastError: JournalDeliveryError | null;
  lastErrorAt: string | null;
  lastDeliveredAt: string | null;
  deliveredEntries: number;
}

/** What one turn of the background writer's delivery job did (background-jobs.ts). */
export interface GaugeJournalDeliveryReport { error: JournalDeliveryError | null; cause?: string; delivered: number; pending: number | null; at?: string }

// One delivery per process; the status is read by the status route on the HTTP thread.
const status: GaugeJournalDeliveryStatus = {
  running: false, lastError: null, lastErrorAt: null, lastDeliveredAt: null, deliveredEntries: 0,
};

/** Bounded delivery health for the status response. Never carries paths or payloads. */
export function gaugeJournalDeliveryStatus(): GaugeJournalDeliveryStatus {
  return { ...status };
}

/** Whether this process has a journal to deliver; set when the server configures it. */
export function setGaugeJournalDelivery(running: boolean): void { status.running = running; }

/**
 * Records a delivery turn. A change of failure class is logged once; progress is counted too, so a
 * backlog that drains and one that is stuck do not look alike.
 */
export function recordGaugeJournalDelivery(report: GaugeJournalDeliveryReport): void {
  const at = report.at ?? new Date().toISOString();
  if (report.delivered) {
    status.deliveredEntries += report.delivered;
    status.lastDeliveredAt = at;
  }
  if (report.error && report.error !== status.lastError)
    console.warn(`[tokenAtlas gauges] delivery unavailable (${report.error}${report.cause ? `: ${report.cause}` : ""}); durable journal work retained`);
  if (report.error) status.lastErrorAt = at;
  status.lastError = report.error;
}
