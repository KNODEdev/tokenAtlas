import { expect, test } from "bun:test";
import { modelColors, modelStrokes, modelVendor, vendorShade } from "./model-colors";

test("each model takes its vendor's hue, whatever screen lists it", () => {
  expect(modelColors(["claude-opus-5", "gpt-6.1-sol", "gemini-3-flash", "grok-4", "glm-5"]))
    .toEqual(["var(--claude)", "var(--codex)", "var(--gemini)", "var(--grok)", "var(--glm)"]);
  expect(modelVendor("codex-auto-review")).toBe("openai");
});

test("models of one vendor get its shades in list order, other vendors keep their own count", () => {
  const colors = modelColors(["claude-opus-5", "gpt-6.1", "claude-sonnet-5.5", "gpt-6.1-mini"]);
  expect(colors).toEqual(["var(--claude)", "var(--codex)", vendorShade("var(--claude)", 1), vendorShade("var(--codex)", 1)]);
  expect(colors[2]).toContain("oklch(from var(--claude)");
});

test("an unprefixed name falls back to the screen's vendor, then to neutral colours", () => {
  expect(modelColors(["antigravity-auto"], "google")).toEqual(["var(--gemini)"]);
  expect(modelStrokes(["a", "b", "c", "d"]).map(stroke => stroke.dash)).toEqual([undefined, undefined, undefined, "6 4"]);
});
