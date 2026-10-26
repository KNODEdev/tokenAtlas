import de from "./locales/de.json";
import fr from "./locales/fr.json";
import type { Language } from "./languages";

const catalogs: Readonly<Record<"de" | "fr", Readonly<Record<string, string>>>> = { de, fr };
export type MessageValues = readonly unknown[];
export type MessageTranslator = (en: string, pl: string, values?: MessageValues) => string;

function interpolate(text: string, values?: MessageValues): string {
  if (!values) return text;
  return text.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}

export function translateForLanguage(language: Language, en: string, pl: string, values?: MessageValues): string {
  if (language === "pl") return pl;
  const catalog = language === "en" ? null : catalogs[language];
  const text = catalog && Object.hasOwn(catalog, en) ? catalog[en]! : en;
  return interpolate(text, values);
}
