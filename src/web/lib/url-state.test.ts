import { describe, expect, it } from "bun:test";
import { formatHash, initialUrlState, parseHash } from "./url-state";

describe("view and subscription in the address", () => {
  it("round-trips a view with its subscription", () => {
    expect(formatHash("usage", "codex1")).toBe("#/usage?account=codex1");
    expect(parseHash("#/usage?account=codex1")).toEqual({ screen: "usage", account: "codex1" });
    const variant = formatHash("periods", "codex1::business");
    expect(parseHash(variant)).toEqual({ screen: "periods", account: "codex1::business" });
  });
  it("leaves out an empty subscription", () => {
    expect(formatHash("settings", "")).toBe("#/settings");
    expect(parseHash("#/settings")).toEqual({ screen: "settings", account: null });
  });
  it("ignores an unknown view and an empty address instead of opening a blank page", () => {
    expect(parseHash("")).toEqual({ screen: null, account: null });
    expect(parseHash("#/no-such-view?account=codex1")).toEqual({ screen: null, account: "codex1" });
    expect(parseHash("#/overview?account=")).toEqual({ screen: "overview", account: null });
  });
  it("reads the opening address through the same parser", () => {
    // Other suites may install a test DOM, so only the shape is asserted here.
    const opening = initialUrlState();
    expect(Object.keys(opening).sort()).toEqual(["account", "screen"]);
  });
});
