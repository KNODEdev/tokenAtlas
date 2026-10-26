import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelShareBar, modelShares } from "./ModelShareBar";
import { TokenComposition } from "./CycleComposition";

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

test("canonical composition counts cache writes and reasoning exactly once", () => {
  const html = renderToStaticMarkup(<TokenComposition tokens={{ input: 100, cached: 40, cache_write: 5, output: 20, reasoning: 7 }} />);
  expect(html).toContain("120 total");
  expect(html).toContain("In total");
  expect(html).toContain("Fresh In");
  expect(html).toContain("55");
  expect(html).toContain("Cache read");
  expect(html).toContain("Cache write");
  expect(html).toContain("Including reasoning: 7");
  expect(html).not.toContain("overlap unknown");
  expect(html).not.toContain("132 total");
});

test("both providers keep zero cache-write counts visible without inventing missing token categories", () => {
  const html = renderToStaticMarkup(<TokenComposition tokens={{ input: 100, cached: 40, cache_write: 0, output: 20, reasoning: 0 }} />);
  expect(html).toContain("Cache write");
  expect(renderToStaticMarkup(<TokenComposition tokens={null} />)).toContain("not prepared yet");
  expect(renderToStaticMarkup(<TokenComposition tokens={null} />)).not.toContain("0 total");
});
