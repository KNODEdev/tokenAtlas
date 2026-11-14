import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KpiStrip } from "./ui";

describe("KPI strip explanations", () => {
  it("puts a figure's explanation behind a visible help dot instead of a native tooltip", () => {
    const html = renderToStaticMarkup(<KpiStrip items={[
      { label: "Return", value: "42×", title: "Used ÷ paid\n$8,861 ÷ $208.72" },
      { label: "Paid", value: "$208.72" },
    ]} />);
    expect(html).toMatch(/Return<span class="ui-help"><button[^>]*class="ui-help-dot"[^>]*aria-label="Return"/);
    // The popup keeps the explanation as one text, line breaks included.
    expect(html).toContain('role="tooltip" class="ui-help-pop" hidden="">Used ÷ paid\n$8,861 ÷ $208.72</span>');
    expect(html).not.toMatch(/class="ui-kpi-cell[^"]*" title=/);
  });
  it("adds no help dot to a figure without an explanation", () => {
    const html = renderToStaticMarkup(<KpiStrip items={[{ label: "Paid", value: "$208.72" }]} />);
    expect(html).not.toContain("ui-help");
    expect(html).toContain('<div class="ui-kpi-label">Paid</div>');
  });
});
