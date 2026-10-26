export const LANGUAGE_OPTIONS = [
  { value: "en", label: "English", locale: "en-US" },
  { value: "pl", label: "Polski", locale: "pl-PL" },
  { value: "de", label: "Deutsch", locale: "de-DE" },
  { value: "fr", label: "Français", locale: "fr-FR" },
] as const;

export type Language = (typeof LANGUAGE_OPTIONS)[number]["value"];

export function isLanguage(value: unknown): value is Language {
  return LANGUAGE_OPTIONS.some(option => option.value === value);
}

export function localeForLanguage(language: Language): string {
  for (const option of LANGUAGE_OPTIONS) {
    if (option.value === language) return option.locale;
  }
  throw new Error("Unsupported language");
}
