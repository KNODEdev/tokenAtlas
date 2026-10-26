import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import { NAVIGATION, navText } from "./screens";
import { CODEX_PROMOTIONS } from "../../shared/codex-promotions";
import { TIBO_PROMISES } from "../../shared/tibo-challenge";

const german: Readonly<Record<string, string>> = de;
const french: Readonly<Record<string, string>> = fr;
const messages = Object.fromEntries(Object.keys(german).map(key => [key, { de: german[key]!, fr: french[key]! }]));
const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();

describe("translation catalogs", () => {
  test("has matching message sets and complete, placeholder-safe German and French values", () => {
    expect(Object.keys(german).sort()).toEqual(Object.keys(french).sort());
    const errors: string[] = [];
    for (const [source, translations] of Object.entries(messages)) {
      for (const language of ["de", "fr"] as const) {
        const value = translations[language];
        if (typeof value !== "string" || (source.trim() && !value.trim())) {
          errors.push(`${language}: missing ${source}`);
          continue;
        }
        if (JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(source))) errors.push(`${language}: placeholders ${source}`);
        if ((source.match(/^\s*/)?.[0] ?? "") !== (value.match(/^\s*/)?.[0] ?? "") ||
            (source.match(/\s*$/)?.[0] ?? "") !== (value.match(/\s*$/)?.[0] ?? "")) errors.push(`${language}: whitespace ${source}`);
      }
    }
    expect(errors).toEqual([]);
  });

  test("covers every literal message used by browser readers", () => {
    const missing = new Set<string>();
    const untranslatedExpressions: string[] = [];
    const sourceRoot = resolve(import.meta.dir, "..");
    for (const relative of new Glob("**/*.{ts,tsx}").scanSync(sourceRoot)) {
      if (relative.includes(".test.") || relative.includes("locales/")) continue;
      const source = readFileSync(resolve(sourceRoot, relative), "utf8");
      if (/\b(?:t|translate)\(\s*(?:`(?:[^`\\]|\\.)*\$\{|"(?:[^"\\]|\\.)*"\s*\+)/.test(source)) untranslatedExpressions.push(relative);
      for (const match of source.matchAll(/\b(?:t|translate)\(\s*("(?:[^"\\]|\\.)*")\s*,/g)) {
        const key = JSON.parse(match[1]!);
        if (!Object.hasOwn(messages, key)) missing.add(key);
      }
    }
    expect([...missing].sort()).toEqual([]);
    expect(untranslatedExpressions).toEqual([]);
  });

  test("translates navigation from its shared registry", () => {
    for (const section of NAVIGATION) {
      for (const label of [section.label, ...section.tabs.flatMap(tab => [tab.label, ...tab.views.map(view => view.label)])]) {
        expect(Object.hasOwn(messages, label.en)).toBe(true);
        expect(navText(label, "de")).toBe(messages[label.en]!.de);
        expect(navText(label, "fr")).toBe(messages[label.en]!.fr);
      }
    }
    expect(navText({ en: "Settings", pl: "Ustawienia" }, "de")).toBe("Einstellungen");
    expect(navText({ en: "Settings", pl: "Ustawienia" }, "fr")).toBe("Paramètres");
  });
});

test("translation catalogs cover provider announcements and their examples", () => {
  const check = (label: { en: string; pl: string }) => expect(Object.hasOwn(messages, label.en)).toBe(true);
  for (const promotion of CODEX_PROMOTIONS) {
    check(promotion.title);
    check(promotion.detail);
    for (const source of promotion.official_sources ?? []) check(source.label);
  }
  for (const promise of TIBO_PROMISES) {
    check(promise);
    if (promise.example) check(promise.example);
  }
});