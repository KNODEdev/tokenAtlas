import { describe, expect, it } from "bun:test";
import { trafficUpdating } from "./traffic-updating";

const scopes = (...names: string[]) => names.map(scope => ({ scope }));

describe("window traffic being updated", () => {
  it("follows the provider's own usage ledger", () => {
    expect(trafficUpdating(scopes("usage-ledger:claude"), "claude")).toBe(true);
    expect(trafficUpdating(scopes("usage-ledger:claude"), "codex")).toBe(false);
    expect(trafficUpdating(scopes("codex-ledger"), "codex")).toBe(true);
    expect(trafficUpdating(scopes("codex-ledger"), "claude")).toBe(false);
  });
  it("follows the window sums of every provider", () => {
    expect(trafficUpdating(scopes("window-usage"), "claude")).toBe(true);
    expect(trafficUpdating(scopes("window-usage"), "codex")).toBe(true);
  });
  it("stays quiet for a synchronization that only looks for changes and for unrelated work", () => {
    expect(trafficUpdating(scopes("sync", "sync:codex", "billing-cycles", "fx-rates", "model-timelines"), "codex")).toBe(false);
    expect(trafficUpdating([], "codex")).toBe(false);
    expect(trafficUpdating(undefined, "codex")).toBe(false);
  });
});
