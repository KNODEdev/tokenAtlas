import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisActivity } from "./AnalysisActivity";

const render = (overrides: Partial<Parameters<typeof AnalysisActivity>[0]> = {}) => renderToStaticMarkup(
  <AnalysisActivity unavailable={false} preparing {...overrides} />,
);

test("a view that is not ready shows its loading state, and a ready view has no panel", () => {
  expect(render()).toContain("Preparing the view");
  expect(render({ preparingLabel: "Loading the account list" })).toContain("Loading the account list");
  expect(render({ preparing: false })).toBe("");
});

test("unavailable progress is stated, never hidden behind the loading state", () => {
  expect(render({ unavailable: true })).toContain("Cannot read progress from the server");
});
