/** A plan's multiplier has one spelling across catalog, period and meter views. */
export function formatPlanLabel(label: string, multiplier: unknown): string {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) return label;
  const name = label.replace(/\s*(?:·\s*)?\(?\s*(?:[×x]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[×x])\s*\)?$/i, "").trim();
  return `${name || label} · ×${multiplier}`;
}
