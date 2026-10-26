import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { isLanguage, localeForLanguage, type Language } from "./languages";
import { translateForLanguage, type MessageTranslator, type MessageValues } from "./messages";
export { translateForLanguage, type MessageTranslator } from "./messages";
export { LANGUAGE_OPTIONS, isLanguage, localeForLanguage, type Language } from "./languages";

const STORAGE_KEY = "tokenatlas.language";
const DEFAULT_LANGUAGE: Language = "en";

let currentLanguage: Language = readStoredLanguage();
const listeners = new Set<() => void>();

function readStoredLanguage(): Language {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function setDocumentLanguage(language: Language): void {
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = language;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getLanguage(): Language {
  return currentLanguage;
}

function getServerLanguage(): Language {
  return currentLanguage;
}

export function setLanguage(language: Language): void {
  if (!isLanguage(language)) return;
  const changed = currentLanguage !== language;
  currentLanguage = language;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Preferences remain available for this session when storage is unavailable.
  }
  setDocumentLanguage(language);
  if (changed) listeners.forEach((listener) => listener());
}

export function getLocale(): string {
  return localeForLanguage(currentLanguage);
}

export function translate(en: string, pl: string, values?: MessageValues): string {
  return translateForLanguage(currentLanguage, en, pl, values);
}

export interface I18nValue {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  t: MessageTranslator;
}

function valueFor(language: Language, changeLanguage: (next: Language) => void = setLanguage): I18nValue {
  return {
    language,
    locale: localeForLanguage(language),
    setLanguage: changeLanguage,
    t: (en, pl, values) => translateForLanguage(language, en, pl, values),
  };
}

export function useI18n(): I18nValue {
  const language = useSyncExternalStore(subscribe, getLanguage, getServerLanguage);
  return useMemo(() => valueFor(language), [language]);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  useEffect(() => {
    setDocumentLanguage(language);
  }, [language]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setLanguage(readStoredLanguage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return children;
}
