import { expect, test } from "bun:test";
import { preferredAccountOrder, selectedAccountId } from "./aggregate";

test("without a valid choice the roster's account with a reading opens first", () => {
  const accounts = [
    { id: "claude-from-sessions", has_gauge: false, has_events: true },
    { id: "claude-detected", has_gauge: false, has_events: false },
    { id: "codex-read", has_gauge: true, has_events: true },
  ];
  const roster = new Set(["claude-detected", "codex-read"]);
  expect(preferredAccountOrder(accounts, roster)).toEqual(["codex-read", "claude-detected", "claude-from-sessions"]);
  // An account outside the roster never opens first: the Overview would wait for its roster entry.
  expect(selectedAccountId("codex1", preferredAccountOrder(accounts, new Set(["claude-detected"])))).toBe("claude-detected");
  expect(selectedAccountId("claude-from-sessions", preferredAccountOrder(accounts, roster))).toBe("claude-from-sessions");
});
