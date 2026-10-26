/** Token types in one order and one colour on every screen that splits tokens (Usage, Models, Usage events). */
export const TOKEN_PARTS = [["input", "var(--accent)"], ["cache_read", "var(--violet)"], ["cache_write", "var(--warn)"], ["output", "var(--ok)"]] as const;
export type TokenPart = (typeof TOKEN_PARTS)[number][0];

export function tokenPartLabel(part: TokenPart, t: (en: string, pl: string) => string): string {
  return {
    input: t("fresh input", "świeże wejście"),
    cache_read: t("cache read", "odczyt z cache"),
    cache_write: t("cache write", "zapis do cache"),
    output: t("output", "wyjście"),
  }[part];
}

/** A known amount without a value (no price, no recorded mode): drawn, never as zero. */
export const UNKNOWN_HATCH = "repeating-linear-gradient(45deg, var(--line2) 0 3px, transparent 3px 6px)";
