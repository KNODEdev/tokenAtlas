import { seriesStroke } from "./model-speed";

/**
 * One hue per vendor across the app (Anthropic orange, OpenAI blue, Google green, xAI grey, Z.ai fuchsia);
 * models and subscriptions of one vendor get shades of it, so the hue alone says whose a line or bar is.
 */
const VENDOR_COLORS: Readonly<Record<string, string>> = {
  anthropic: "var(--claude)", claude: "var(--claude)",
  openai: "var(--codex)", codex: "var(--codex)",
  google: "var(--gemini)", gemini: "var(--gemini)",
  xai: "var(--grok)", grok: "var(--grok)",
  zai: "var(--glm)", "z.ai": "var(--glm)", glm: "var(--glm)", opencode: "var(--glm)",
};
/**
 * Distinct inks for series of one subject (projects of a window, models of one subscription), assigned by rank so
 * the largest neighbours in a stack never share a hue; status brick stays out.
 */
export const DISTINCT_INKS: readonly string[] = ["var(--accent)", "var(--claude)", "var(--violet)", "var(--gemini)", "var(--glm)", "var(--warn)",
  "color-mix(in oklab, var(--accent) 45%, var(--violet))", "color-mix(in oklab, var(--claude) 50%, var(--violet))",
  "color-mix(in oklab, var(--gemini) 50%, var(--warn))", "color-mix(in oklab, var(--accent) 50%, var(--gemini))"];
/** Models no vendor claims: colours outside the vendor hues. */
const NEUTRAL_SHADES = ["var(--violet)", "var(--warn)", "var(--muted)"];

export function vendorColor(vendor: string | null | undefined): string | null {
  return vendor ? VENDOR_COLORS[vendor.toLowerCase()] ?? null : null;
}

export function classifyModelFamily(model: string): string | null {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")
    || m.startsWith("chatgpt-") || m.startsWith("text-embedding-")) return "openai";
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "google";
  if (m.startsWith("glm-")) return "zai";
  if (m.startsWith("grok-")) return "xai";
  return null;
}

/** The vendor whose hue a model takes; Codex's own internal models are OpenAI's. */
export function modelVendor(model: string | null | undefined): string | null {
  if (!model) return null;
  return classifyModelFamily(model) ?? (model.toLowerCase().startsWith("codex-") ? "openai" : null);
}

// OKLCH lightness steps keep the hue and alternate darker and lighter, so neighbours in a list stay apart;
// the clamp keeps the grey of xAI (already near white in the dark theme) from collapsing into one shade.
const SHADE_STEPS = [0, -0.12, 0.08, -0.22, 0.14, -0.3];
export const SHADE_COUNT = SHADE_STEPS.length;

/** The `index`-th shade of a vendor colour; index 0 is the colour itself. */
export function vendorShade(base: string, index: number): string {
  const step = SHADE_STEPS[index % SHADE_COUNT]!;
  return step === 0 ? base : `oklch(from ${base} clamp(0.32, calc(l ${step < 0 ? "-" : "+"} ${Math.abs(step)}), 0.95) c h)`;
}

/**
 * Colour and dash per model in list order: each model takes its vendor's next shade, and a vendor that runs out of
 * shades repeats them dashed. `fallbackVendor` covers model names without a vendor prefix (a provider's own screen).
 */
export function modelStrokes(models: ReadonlyArray<string | null>, fallbackVendor?: string): { color: string; dash: string | undefined }[] {
  const seen = new Map<string, number>();
  return models.map(model => {
    const base = vendorColor(modelVendor(model) ?? fallbackVendor);
    const group = base ?? "";
    const rank = seen.get(group) ?? 0;
    seen.set(group, rank + 1);
    return seriesStroke(rank, base ? SHADE_STEPS.map((_, i) => vendorShade(base, i)) : NEUTRAL_SHADES);
  });
}

/** The fill per model in list order (bars and dots): the stroke colour without its dash. */
export function modelColors(models: ReadonlyArray<string | null>, fallbackVendor?: string): string[] {
  return modelStrokes(models, fallbackVendor).map(stroke => stroke.color);
}
