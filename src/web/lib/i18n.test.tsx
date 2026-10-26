import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocale, I18nProvider, isLanguage, LANGUAGE_OPTIONS, localeForLanguage, setLanguage, translate, translateForLanguage, useI18n } from "./i18n";
import { preserveBrowserGlobals } from "./test-dom-globals";

function Probe() {
  const { t, locale } = useI18n();
  return createElement("span", null, `${t("Hello", "Cześć")} · ${translate("world", "świat")} · ${locale}`);
}

describe("i18n foundation", () => {
  it("defaults to English regardless of browser language", () => {
    const restore = preserveBrowserGlobals();
    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { navigator: { language: "pl-PL" }, localStorage: { getItem: () => null } },
      });
      setLanguage("en");
      expect(renderToStaticMarkup(createElement(Probe))).toContain("Hello · world · en-US");
      expect(getLocale()).toBe("en-US");
    } finally {
      setLanguage("en");
      restore();
    }
  });

  it("switches language and persists the selected value", () => {
    const restore = preserveBrowserGlobals();
    const values = new Map<string, string>();
    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } },
      });
      setLanguage("pl");
      expect(translate("English", "Polski")).toBe("Polski");
      expect(values.get("tokenatlas.language")).toBe("pl");
      expect(renderToStaticMarkup(createElement(Probe))).toContain("Cześć · świat · pl-PL");
      setLanguage("en");
      expect(values.get("tokenatlas.language")).toBe("en");
    } finally {
      setLanguage("en");
      restore();
    }
  });

  it("continues working when browser storage is blocked", () => {
    const restore = preserveBrowserGlobals();
    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          localStorage: {
            getItem: () => { throw new Error("blocked"); },
            setItem: () => { throw new Error("blocked"); },
          },
        },
      });
      expect(() => setLanguage("pl")).not.toThrow();
      expect(translate("English", "Polski")).toBe("Polski");
    } finally {
      setLanguage("en");
      restore();
    }
  });

  it("keeps components and standalone helpers on the same language snapshot", () => {
    setLanguage("pl");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, { children: createElement(Probe) }),
    );
    expect(html).toContain("Cześć · świat · pl-PL");
    setLanguage("en");
  });
});

const NewLanguageProbe = () => {
  const { t, locale } = useI18n();
  return createElement("span", null, `${t("Settings", "Ustawienia")} · ${translate("Projects", "Projekty")} · ${locale}`);
};

describe("German and French", () => {
  it("offers the same four languages to every language selector", () => {
    expect(LANGUAGE_OPTIONS.map(({ value, label }) => [value, label])).toEqual([
      ["en", "English"], ["pl", "Polski"], ["de", "Deutsch"], ["fr", "Français"],
    ]);
    for (const { value, locale } of LANGUAGE_OPTIONS) {
      expect(isLanguage(value)).toBe(true);
      expect(localeForLanguage(value)).toBe(locale);
    }
    expect(isLanguage("es")).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });

  for (const [language, locale, settings, projects] of [
    ["de", "de-DE", "Einstellungen", "Projekte"],
    ["fr", "fr-FR", "Paramètres", "Projets"],
  ] as const) {
    it(`shares ${language} between hooks, helpers, document language and storage`, () => {
      const restore = preserveBrowserGlobals();
      const values = new Map<string, string>();
      const root = { lang: "en" };
      try {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {
          localStorage: { getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value) },
        } });
        Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
        setLanguage(language);
        expect(values.get("tokenatlas.language")).toBe(language);
        expect(root.lang).toBe(language);
        expect(getLocale()).toBe(locale);
        expect(renderToStaticMarkup(createElement(NewLanguageProbe))).toContain(`${settings} · ${projects} · ${locale}`);
        expect(new Intl.NumberFormat(getLocale()).format(1234.5)).toBe(new Intl.NumberFormat(locale).format(1234.5));
      } finally {
        setLanguage("en");
        restore();
      }
    });
  }

  it("preserves interpolated values and the existing English and Polish output", () => {
    const en = "{0} days ago";
    const pl = "7 dni";
    expect(translateForLanguage("en", en, pl, [7])).toBe("7 days ago");
    expect(translateForLanguage("pl", en, pl, [7])).toBe(pl);
    expect(translateForLanguage("de", en, pl, [7])).toBe("vor 7 Tagen");
    expect(translateForLanguage("fr", en, pl, [7])).toBe("il y a 7 jours");
    expect(translateForLanguage("de", "{0} days ago", "", ["$& {1}"])).toBe("vor $& {1} Tagen");
  });

  it("keeps provider identifiers explicit when a message is unknown", () => {
    expect(translateForLanguage("de", "unknown-vendor:abc", "nieznany")).toBe("unknown-vendor:abc");
    expect(translateForLanguage("fr", "unknown-vendor:abc", "nieznany")).toBe("unknown-vendor:abc");
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(translateForLanguage("de", key, "")).toBe(key);
      expect(translateForLanguage("fr", key, "")).toBe(key);
    }
  });

  it("ignores invalid language values at runtime", () => {
    setLanguage("en");
    setLanguage("invalid" as never);
    expect(getLocale()).toBe("en-US");
  });
});