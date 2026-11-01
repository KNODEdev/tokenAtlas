import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBar, type StatusBarProps } from "./StatusBar";
import type { SyncStatus } from "../lib/api";

// TALK-001 D12: a running import shows Pause on its bar; a paused one shows its state and Resume, no estimate.
const base: StatusBarProps = { sync: { running: false, run: null } as unknown as SyncStatus, syncUnavailable: false, syncObservedAt: null,
  rebuild: { job: null, unavailable: false }, waitingForSubscriptions: false, stickyTop: 52, onOpenSettings: () => {} };
const render = (sync: Partial<SyncStatus>) => renderToStaticMarkup(<StatusBar {...base} sync={{ ...base.sync, ...sync } as SyncStatus} />);

test("a running import offers Pause, and so does an analysis rebuild's source pass", () => {
  const running = render({ running: true, run: { scope: { kind: "all" }, mode: "incremental", status: "running", progress: { phase: "scan", completed: 1, total: 5 }, vendors: [] } as never });
  expect(running).toContain('data-import-pause="pause"');
  const rebuild = render({ running: true, run: { rebuildGeneration: 3, scope: { kind: "all" }, mode: "incremental", status: "running", progress: { phase: "scan", completed: 1, total: 5 }, vendors: [] } as never });
  expect(rebuild).toContain('data-import-pause="pause"');
});

test("a paused import shows its state with Resume and no time estimate", () => {
  const html = render({ running: false, paused: true });
  expect(html).toContain("Import paused");
  expect(html).toContain('data-import-pause="resume"');
  expect(html).not.toContain("min left");
});
