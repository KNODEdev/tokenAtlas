import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelShareBar, modelShares } from "./ModelShareBar";
import { UsageComposition } from "./CycleComposition";
import type { CycleView } from "../lib/cycle";

test("missing prices stay unknown, including the merged tail and total", () => {
  const rows = [
    { name: "priced", calls: 1, tokens: 100, fresh: 100, usd: 2 },
    { name: "missing", calls: 1, tokens: 50, fresh: 50, usd: 0, usd_partial: true },
    { name: "smaller", calls: 1, tokens: 10, fresh: 10, usd: 1 },
  ];
  const html = renderToStaticMarkup(<ModelShareBar rows={rows} usedPercent={50} />);
  expect(html).not.toContain("$0.00");
  expect(html).toContain("≥ $3.00");
  expect(html).toContain("Incomplete price coverage");
  const merged = modelShares(rows, 50, 1);
  expect(merged.shares[1]).toMatchObject({ usd: 1, usd_partial: true, tokens: 60 });
  expect(renderToStaticMarkup(<ModelShareBar rows={rows} usedPercent={50} limit={1} />)).toContain("≥ $1.00");
});

test("token composition counts reasoning once and excludes ambiguous cache writes from the total", () => {
  const cycle = { label: "#31", raw: { tokens: { in: 100, cached_in: 40, out: 20, reasoning: 7, cache_write: 5, total: 120 } } } as CycleView;
  const html = renderToStaticMarkup(<UsageComposition cycle={cycle} />);
  expect(html).toContain("120 gross");
  expect(html).not.toContain("#31");
  expect(html).not.toContain("in window");
  expect(html).toContain("output (without reasoning)");
  expect(html).toContain("reasoning (within output)");
  expect(html).toContain("cache write (overlap unknown)");
  expect(html).not.toContain("132 gross");
});

test("token composition hides the cache-write legend when no writes exist", () => {
  const cycle = { label: "#31", raw: { tokens: { in: 100, cached_in: 40, out: 20, reasoning: 7, cache_write: 0, total: 120 } } } as CycleView;
  expect(renderToStaticMarkup(<UsageComposition cycle={cycle} />)).not.toContain("cache write (overlap unknown)");
});
