import { describe, expect, test } from "bun:test";
import { resolveRailMode } from "./useBreakpoint";

// TALK-001 D8: the user's collapse of the subscription rail applies where the window fits both forms;
// a narrower window still compacts or hides it, whatever was saved.
describe("subscription rail mode", () => {
  test("a saved compact choice narrows the full rail", () => {
    expect(resolveRailMode("full", "compact")).toBe("compact");
    expect(resolveRailMode("full", "full")).toBe("full");
  });
  test("a saved full choice never widens a rail the window cannot hold", () => {
    expect(resolveRailMode("compact", "full")).toBe("compact");
    expect(resolveRailMode("none", "full")).toBe("none");
    expect(resolveRailMode("none", "compact")).toBe("none");
  });
});
