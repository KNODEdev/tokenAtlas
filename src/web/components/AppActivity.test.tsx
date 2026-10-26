import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppActivityDetails } from "./AppActivity";
import type { AppActivity as Snapshot, ActivityStage } from "../../shared/app-activity";
import type { SyncStatus } from "../lib/api";

const stage = (state: ActivityStage["state"]): ActivityStage => ({ state, version: 8, checkpoint: 100, cursor: 200, lastProgressAt: 1000, etaMs: null });
const snapshot: Snapshot = {
  observedAt: 2000, observationStartedAt: 500, unavailable: false, busy: true,
  providers: [{ provider: "codex", register: stage("backfill"), facts: null }, { provider: "grok", register: stage("ready"), facts: stage("ready") }],
  reports: { pending: 1, failed: 0, truncated: false, views: [{ view: "subscriptions", pending: 1, failed: 0 }] },
  progress: [],
};
const props = { sync: { running: false, run: null } as SyncStatus, syncUnavailable: false, syncObservedAt: 2000,
  rebuild: { job: null, unavailable: false }, waitingForSubscriptions: true };
const render = (extra: Partial<Parameters<typeof AppActivityDetails>[0]> = {}) => renderToStaticMarkup(
  <AppActivityDetails {...props} data={snapshot} unavailable={false} staleAt={null} {...extra} />);

test("tasks are rows with a bar and a count; sentences and times stay in help dots", () => {
  const entry = (scope: string, done: number, total: number) => ({ scope, step: "windows", label: "preparing capacity cycles", done, total,
    unit: "accounts" as const, startedAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:01Z" });
  const tasks = [{ scope: "limit-windows", name: "Limit windows", entry: entry("limit-windows", 11, 21), fraction: 11 / 21 },
    { scope: "capacity-cycle-results", name: "Capacity cycles", entry: entry("capacity-cycle-results", 0, 1), fraction: 0 },
    { scope: "account-periods", name: "Account periods", entry: null, fraction: 1 }];
  const html = render({ tasks });
  expect(html).toContain("Background tasks");
  expect(html).toContain("11 / 21 accounts");
  expect(html).toContain(">pending<");
  expect(html).toContain(">done<");
  expect(html).not.toContain("capacity-cycle-results:");
  expect(html).not.toContain("dividing limit windows");
  // No paragraph boxes: the waiting providers and observation times sit in the heading's help dot.
  expect(html).not.toContain("app-activity-explanation");
  expect(html).toContain('class="ui-help-block">Subscription cards are waiting for: Codex<');
  expect(html).toContain("Codex · building history");
  expect(html).toContain("Subscriptions");
});

test("unavailable status retains the last observation and puts the stale time in a help dot", () => {
  const html = render({ unavailable: true, syncUnavailable: true, staleAt: 500 });
  expect(html).toContain("Cannot read current progress");
  expect(html).toContain("last observed state");
  expect(html).toMatch(/<span class="is-warn">unavailable<\/span>/);
  expect(html).toContain("Last consistent result");
});

test("partial queue counts are lower bounds and failures are explicit", () => {
  const html = render({ data: { ...snapshot, reports: { pending: 2, failed: 1, truncated: true,
    views: [{ view: "history", pending: 2, failed: 1 }] } } });
  expect(html).toContain("counts are lower bounds");
  expect(html).toContain("≥2 waiting");
  expect(html).toContain('<span class="is-warn">1 failed</span>');
});

test("queue failure explains the next action and no observation does not invent movement", () => {
  const html = render({ data: { ...snapshot,
    providers: [{ provider: "codex", register: { ...stage("backfill"), lastProgressAt: null }, facts: null }],
    reports: { pending: 0, failed: 1, truncated: false,
      views: [{ view: "overview", pending: 0, failed: 1, issues: [{ reason: "account-unavailable", count: 1 }] }] } } });
  expect(html).toContain("Select an existing account");
  expect(html).toContain("no progress observed yet");
  expect(html).not.toContain("progress at");
  expect(html).not.toContain("aria-valuenow");
});
