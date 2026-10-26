import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHeader } from "../components/AppHeader";
import { contextPreviewAppliesTo, setContextPreview } from "./context-premium";
import { setLanguage } from "./i18n";
import type { ScreenId } from "./screens";

test("context preview includes the stored-window history; partially covered screens remain explicit", () => {
  const covered: ScreenId[] = ["capacity", "plans", "model-traffic", "history", "usage", "usage-history", "usage-pace",
    "structure", "structure-models", "events", "models", "periods", "shares"];
  const remaining: ScreenId[] = ["overview", "compare", "analytics", "patterns", "speed",
    "projects", "sources", "settings", "activity", "data-problems", "data-operations"];
  for (const screen of covered) expect(contextPreviewAppliesTo(screen)).toBe(true);
  for (const screen of remaining) expect(contextPreviewAppliesTo(screen)).toBe(false);
});

test("the header marks unsupported screens only while the preview is on", () => {
  setLanguage("en");
  const render = (applies: boolean) => renderToStaticMarkup(<AppHeader account="" accounts={[]} theme="light"
    onToggleTheme={() => {}} onOpenPalette={() => {}} goto={() => {}} contextPreviewApplies={applies} />);
  try {
    setContextPreview(false);
    expect(render(false)).not.toContain("data-unsupported");
    setContextPreview(true);
    expect(render(false)).toContain('data-unsupported=""');
    expect(render(false)).toContain("Amounts on this screen do not include the preview yet.");
    expect(render(true)).not.toContain("data-unsupported");
    expect(render(true)).not.toContain("Amounts on this screen do not include the preview yet.");
  } finally { setContextPreview(false); }
});
