import { describe, expect, test } from "bun:test";
import type { ApiAccount } from "./api";
import type { CycleView } from "./cycle";
import { setLanguage } from "./i18n";
import { cycleEventsTarget, eventFiltersFor, eventsRequest, historyEventsTarget, windowDates, type EventsTarget } from "./events-filter";

const account = (id: string, vendor: string): ApiAccount => ({ id, vendor, plan: null, login: null, machine: null, note: null, homes: [],
  ratelimit_rows: 0, event_rows: 1, windows: [], limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: false, has_events: true });
const accounts = [account("codex1", "codex"), account("claude-max", "claude"), account("grok", "grok"), account("glm", "glm")];

describe("Usage events filters", () => {
  test("follow the header subscription: Codex and Claude by account, other providers by provider", () => {
    expect(eventsRequest(eventFiltersFor("codex1", accounts, "", null), 0, 50)).toEqual({
      account: "codex1", order: "ts_desc", model: undefined, project_id: undefined, since: undefined, until: undefined, limit: 50, offset: 0,
    });
    expect(eventsRequest(eventFiltersFor("claude-max", accounts, "p1", null), 50, 50)).toMatchObject({ account: "claude-max", project_id: "p1", offset: 50 });
    const grok = eventsRequest(eventFiltersFor("grok", accounts, "", null), 0, 50);
    expect(grok).toMatchObject({ vendor: "grok" });
    expect(grok).not.toHaveProperty("account");
    expect(eventsRequest(eventFiltersFor("glm", accounts, "", null), 0, 50)).toMatchObject({ vendor: "opencode" });
    expect(eventsRequest(eventFiltersFor("__all__", accounts, "", null), 0, 50)).toMatchObject({ vendor: "all" });
  });

  test("a navigation target sends its account, UTC dates and model; a target for another subscription is ignored", () => {
    const target: EventsTarget = { account: "codex1", since: "2026-09-12", until: "2026-09-19", model: "gpt-6-sol", origin: "Models › codex1 › gpt-6-sol", returnScreen: "models" };
    expect(eventsRequest(eventFiltersFor("codex1", accounts, "", target), 0, 50)).toMatchObject({
      account: "codex1", since: "2026-09-12", until: "2026-09-19", model: "gpt-6-sol",
    });
    expect(eventFiltersFor("claude-max", accounts, "", target)).toMatchObject({ account: "claude-max", since: "", until: "", model: "" });
  });
});

describe("History → Usage events", () => {
  test("a window covers the UTC days from its start to its exclusive end, never past today", () => {
    expect(windowDates("2026-09-12T14:05:00.000Z", "2026-09-19T14:05:00.000Z", Date.parse("2026-09-27T00:00:00Z")))
      .toEqual({ since: "2026-09-12", until: "2026-09-19" });
    // A reset at midnight does not pull in the next day.
    expect(windowDates("2026-09-12T00:00:00.000Z", "2026-09-19T00:00:00.000Z", Date.parse("2026-09-27T00:00:00Z")))
      .toEqual({ since: "2026-09-12", until: "2026-09-18" });
    expect(windowDates("2026-09-24T10:00:00.000Z", null, Date.parse("2026-09-26T08:00:00Z"))).toEqual({ since: "2026-09-24", until: "2026-09-26" });
    expect(windowDates("2026-09-24T10:00:00.000Z", "2026-10-01T10:00:00.000Z", Date.parse("2026-09-26T08:00:00Z"))).toEqual({ since: "2026-09-24", until: "2026-09-26" });
  });

  test("a closed cycle ends at its last work, a running one now, and both lead back to History", () => {
    setLanguage("en");
    const closed = { number: 69, startIso: "2026-09-12T14:05:00.000Z", endIso: "2026-09-19T14:05:00.000Z", isActive: false,
      raw: { work_to_ts: "2026-09-18T20:00:00.000Z" } } as unknown as CycleView;
    const target = cycleEventsTarget("codex1", closed);
    // T-11: the cycle's own end bounds it, so its last counted call (work_to_ts) stays inside.
    expect(target).toMatchObject({ account: "codex1", since: "2026-09-12", until: "2026-09-19", returnScreen: "history",
      fromTs: "2026-09-12T14:05:00.000Z", untilTs: "2026-09-19T14:05:00.000Z" });
    expect(eventsRequest(eventFiltersFor("codex1", [], "", target), 0, 50)).toMatchObject({ from_ts: target.fromTs, until_ts: target.untilTs });
    expect(eventsRequest(eventFiltersFor("codex1", [], "", target), 0, 50)).not.toHaveProperty("since");
    expect(target.origin.startsWith("History › codex1 › #69 · ")).toBe(true);
    const running = cycleEventsTarget("codex1", { ...closed, isActive: true });
    expect(running.until).toBe(new Date().toISOString().slice(0, 10));
    expect([running.fromTs, running.untilTs]).toEqual(["2026-09-12T14:05:00.000Z", undefined]);
    expect(running.origin).toContain("→ now");
    expect(historyEventsTarget("claude-max", "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z")).toMatchObject({ since: "2026-09-01", until: "2026-09-07" });
  });
});
