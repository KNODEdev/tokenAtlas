import { expect, test } from "bun:test";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { chosenCycles, comparableAccounts, leaveOutCycles, subscriptionColors } from "./capacity-compare";
import type { CapacityAccountResult } from "./global-capacity";
import { EMPTY_SELECTION, setAccounts, toggleModel } from "./model-speed";

const account = (id: string, provider: string, active = true) => ({ id, provider, active, label: id });
const cycle = (id: string, start: string, observed_pp = 50) => ({ id, start, cycle_start: start, observed_pp }) as CodexComparisonWindow;
const result = (id: string, provider: string, windows: CodexComparisonWindow[]) => ({ account: account(id, provider), counter: "weekly", counterLabel: "Weekly", windows }) as CapacityAccountResult;

test("each subscription keeps a shade of its provider's hue whatever else is chosen", () => {
  const colors = subscriptionColors([account("codex2", "codex"), account("claude-a", "claude"), account("codex1", "codex")]);
  expect(colors.get("codex1")).toBe("var(--codex)");
  expect(colors.get("codex2")).toContain("var(--codex)");
  expect(colors.get("codex2")).not.toBe("var(--codex)");
  expect(colors.get("claude-a")).toBe("var(--claude)");
  expect(comparableAccounts([account("codex1::business", "codex"), account("x", "opencode"), account("g", "gemini")]).map(item => item.id)).toEqual(["g"]);
});

test("chosen cycles of every chosen subscription run oldest first; an inactive one waits for opting in", () => {
  const accounts = [account("codex1", "codex"), account("claude-a", "claude"), account("old", "claude", false)];
  const results = new Map([
    ["codex1", [result("codex1", "codex", [cycle("c2", "2026-09-08T00:00:00Z"), cycle("c1", "2026-09-01T00:00:00Z")])]],
    ["claude-a", [result("claude-a", "claude", [cycle("a1", "2026-09-03T00:00:00Z", 10)])]],
    ["old", [result("old", "claude", [cycle("o1", "2026-09-02T00:00:00Z")])]],
  ]);
  const inactive = new Set(["old"]);
  const ids = (selection = EMPTY_SELECTION) => chosenCycles(results, accounts, selection, inactive).map(item => item.window.id);
  expect(ids()).toEqual(["c1", "a1", "c2"]);
  expect(ids(setAccounts(EMPTY_SELECTION, ["old"], true, inactive))).toEqual(["c1", "o1", "a1", "c2"]);
  expect(ids(toggleModel(EMPTY_SELECTION, "codex1", "c1", ["c1", "c2"], inactive))).toEqual(["a1", "c2"]);
  // Leaving out small samples keeps cycles the user left out before.
  const left = leaveOutCycles(toggleModel(EMPTY_SELECTION, "codex1", "c2", ["c1", "c2"], inactive), "claude-a", ["a1"]);
  expect(ids(left)).toEqual(["c1"]);
  expect(leaveOutCycles(left, "codex1", [])).toBe(left);
});
