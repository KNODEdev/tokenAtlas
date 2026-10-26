import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartExport } from "./ChartExport";
import { clipboardImageFormat, copyCardImage, EXPORT_SITE } from "./card-png";
import { reportImageFileName, setPrivacyEnabled } from "../lib/privacy";

const original = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "ClipboardItem", original);
  else Reflect.deleteProperty(globalThis, "ClipboardItem");
  setPrivacyEnabled(false);
});

test("chart controls name their chart and remain outside the captured content", () => {
  const html = renderToStaticMarkup(<ChartExport title="API history"><svg aria-label="API" /><div>legend</div></ChartExport>);
  expect(html).toContain('data-chart-export=""');
  expect(html).toContain('Copy chart: API history');
  expect(html).toContain('Save WebP: API history');
  expect(html).toContain('data-capture-exclude=""');
  expect(html.indexOf('legend')).toBeLessThan(html.indexOf('data-capture-exclude'));
  expect(EXPORT_SITE).toBe("tokenAtlas.dev");
});

test("clipboard selects WebP only when explicitly supported", () => {
  Reflect.deleteProperty(globalThis, "ClipboardItem");
  expect(clipboardImageFormat()).toBe("image/png");
  Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: { supports: (type: string) => type === "image/webp" } });
  expect(clipboardImageFormat()).toBe("image/webp");
  Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: { supports: () => false } });
  expect(clipboardImageFormat()).toBe("image/png");
  Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: {} });
  expect(clipboardImageFormat()).toBe("image/png");
});

test("unsupported clipboard reports a useful failure before rasterizing", async () => {
  Reflect.deleteProperty(globalThis, "ClipboardItem");
  await expect(copyCardImage({} as HTMLDivElement)).rejects.toThrow("save the WebP");
});

test("private filenames preserve their actual encoding", () => {
  setPrivacyEnabled(true);
  expect(reportImageFileName("private-project.webp")).toBe("tokenatlas-private.webp");
  expect(reportImageFileName("private-project.png")).toBe("tokenatlas-private.png");
  setPrivacyEnabled(false);
  expect(reportImageFileName("public-chart.webp")).toBe("public-chart.webp");
});
