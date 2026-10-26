import { expect, test } from "bun:test";
import { keepsSocketOpen } from "./api";

test("every registered API route keeps its socket while the answer is prepared", () => {
  // /api/roster and /api/windows are direct reads outside DATA_VIEWS; their cold reads took over 10 s.
  for (const route of ["/api/roster", "/api/windows", "/api/usage-series", "/api/cycle-breakdown", "/api/account-periods", "/api/sync"])
    expect(keepsSocketOpen(route)).toBe(true);
  expect(keepsSocketOpen("/api/nonexistent")).toBe(false);
  expect(keepsSocketOpen("/assets/index.js")).toBe(false);
  expect(keepsSocketOpen("/")).toBe(false);
});
