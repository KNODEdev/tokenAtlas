import type { WindowTokenCounts } from "../../shared/window-model-usage";

export function sumWindowTokens(rows: readonly WindowTokenCounts[]): WindowTokenCounts {
  return rows.reduce((sum, row) => ({
    input: sum.input + row.input, cached: sum.cached + row.cached,
    cache_write: sum.cache_write + row.cache_write, output: sum.output + row.output,
    cache_write_complete: sum.cache_write_complete !== false && row.cache_write_complete !== false,
    reasoning: sum.reasoning + row.reasoning,
  }), { input: 0, cached: 0, cache_write: 0, output: 0, reasoning: 0 });
}

export const freshWindowInput = (row: WindowTokenCounts): number => row.input - row.cached - row.cache_write;
export const totalWindowTokens = (row: WindowTokenCounts): number => row.input + row.output;

export function windowTokenLabels(t: (en: string, pl: string) => string) {
  return {
    input: t("In total", "In łącznie"), fresh: t("Fresh In", "Świeży In"), cached: "Cache read",
    cache_write: "Cache write", cache_share: "Cache / In", output: "Output",
    total: t("Tokens · share", "Tokeny · udział"),
  };
}

export function windowTokenDefinitions(t: (en: string, pl: string) => string) {
  return {
    input: t("All input = fresh input + cache read + cache write.", "Cały input = świeży input + odczyt z cache + zapis do cache."),
    fresh: t("Fresh input = all input − cache read − cache write. Output is not included.", "Świeży input = cały input − odczyt z cache − zapis do cache. Nie zawiera outputu."),
    cached: t("Input read from cache; already included in In total.", "Input odczytany z cache; zawiera się już w In łącznie."),
    cache_write: t("Input written to cache; already included in In total. — means the source total is unavailable, not zero; ≥ marks reported writes without confirmed completeness. Cache read does not determine cache writes.", "Input zapisany do cache; zawiera się już w In łącznie. — oznacza brak dostępnej sumy źródłowej, nie zero; ≥ oznacza zaraportowane zapisy bez potwierdzonej kompletności. Cache read nie pozwala wyliczyć cache write."),
    cache_share: t("Cache read / all input. This is not the share of all tokens.", "Odczyt z cache / cały input. To nie jest udział we wszystkich tokenach."),
    output: t("All output, including reasoning. Reasoning is not added again.", "Cały output, łącznie z rozumowaniem. Rozumowania nie dodajemy ponownie."),
    total: t("Total tokens = all input + output. Cache and reasoning are not added a second time.", "Tokeny razem = cały input + output. Cache i rozumowania nie dodajemy drugi raz."),
  };
}
