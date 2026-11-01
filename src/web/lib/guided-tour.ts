import type { MessageTranslator } from "./i18n";

/** State of the guided tour (components/GuidedTour.tsx, TALK-001 D10/D13), kept on this computer. */
export const STATE_KEY = "tokenatlas.tour.v1";
export const PENDING_KEY = "tokenatlas.tour.pending";
export type TourState = "done" | "skipped" | "declined";

export function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function write(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Storage can be unavailable. */ }
}

/** Called by the consent screen: the tour opens with the application that follows it. */
export function requestTourAfterConsent(): void {
  write(PENDING_KEY, "1");
}

export type TourMode = "idle" | "offer" | "running";
/** A pending start wins; an installation with no remembered answer gets the one-time offer. */
export function initialTourMode(state: string | null, pending: boolean): TourMode {
  return pending ? "running" : state ? "idle" : "offer";
}

export interface TourStep { target: string; title: string; body: string; last?: boolean }
export function tourSteps(t: MessageTranslator): TourStep[] {
  return [
    { target: ".shell-nav", title: t("Menu", "Menu"),
      body: t("The main areas of the app. « at its bottom narrows the menu to icons.", "Główne obszary aplikacji. « na dole zwęża menu do ikon.") },
    { target: ".subs-rail", title: t("Subscriptions", "Subskrypcje"),
      body: t("Each subscription with its limit. « beside the settings shrinks the panel to the most important figures.",
        "Każda subskrypcja z jej limitem. « obok ustawień zwija panel do najważniejszych liczb.") },
    { target: "section[role=\"status\"]", title: t("Import and status", "Import i stan"),
      body: t("Progress of the import and the state of the app. Pause stops the import; details open below the bar.",
        "Postęp importu i stan aplikacji. Wstrzymaj zatrzymuje import; szczegóły rozwijają się pod paskiem.") },
    { target: "main .ui-help-dot", title: t("Question marks", "Znaki zapytania"),
      body: t("Point at a ? to see what a figure means and where it comes from.", "Najedź na ?, aby zobaczyć, co znaczy liczba i skąd pochodzi.") },
    { target: "[data-tour-help]", title: t("This tour", "Ten przewodnik"),
      body: t("Show it again any time with ?.", "Pokażesz go ponownie w każdej chwili przyciskiem ?.") },
    { target: "[data-nav=\"usage\"]", title: t("First numbers", "Pierwsze liczby"), last: true,
      body: t("Tokens and costs appear in Usage as soon as the import reaches them, also without limit readings.",
        "Tokeny i koszty pojawiają się w Zużyciu, gdy tylko import do nich dotrze, także bez odczytów limitów.") },
  ];
}

/** Steps whose element is on screen now; a hidden one (a rail too narrow to show) is skipped, never shown floating. */
export function presentSteps(steps: readonly TourStep[], visible: (selector: string) => boolean): TourStep[] {
  return steps.filter(step => visible(step.target));
}

