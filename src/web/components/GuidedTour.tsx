import { useEffect, useState } from "react";
import { useI18n, type MessageTranslator } from "../lib/i18n";
import { GhostButton } from "./ui";
import "./GuidedTour.css";

/**
 * A short tour of what is where (TALK-001 D10/D13): it starts by itself after the first-run consent, while the
 * import runs, and "?" in the header replays it. An installation that predates it gets one offer, once.
 * Bubbles sit beside their element and never cover the status bar, so the progress and Pause stay usable.
 */
const STATE_KEY = "tokenatlas.tour.v1";
const PENDING_KEY = "tokenatlas.tour.pending";
type TourState = "done" | "skipped" | "declined";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
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

function targetRect(selector: string): DOMRect | null {
  const element = document.querySelector(selector);
  const rect = element?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

const BUBBLE_W = 300, GAP = 12;
/**
 * Beside a tall element (menu, rail), under a wide one (status bar), always inside the window and never over
 * the status bar, so the import's progress and Pause stay visible (TALK-001 REQ-068 AC6).
 */
function bubblePosition(rect: DOMRect): { left: number; top: number } {
  const beside = rect.height > rect.width && rect.right + GAP + BUBBLE_W < window.innerWidth;
  const left = beside ? rect.right + GAP : Math.min(Math.max(8, rect.left), window.innerWidth - BUBBLE_W - 8);
  const statusBottom = document.querySelector("section[role=\"status\"]")?.getBoundingClientRect().bottom ?? 0;
  const top = Math.max(beside ? rect.top + 24 : rect.bottom + GAP, statusBottom + GAP);
  return { left, top: Math.min(top, window.innerHeight - 180) };
}

export function GuidedTour({ replay, onOpenUsage }: { replay: number; onOpenUsage: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<TourMode>(() => initialTourMode(read(STATE_KEY), read(PENDING_KEY) === "1"));
  const [index, setIndex] = useState(0);
  const [, setTick] = useState(0);
  useEffect(() => { write(PENDING_KEY, null); }, []);
  useEffect(() => { if (replay > 0) { setIndex(0); setMode("running"); } }, [replay]);
  // The layout moves while the import fills the screens; the bubble follows its element.
  useEffect(() => {
    if (mode !== "running") return;
    const follow = () => setTick(tick => tick + 1);
    const timer = setInterval(follow, 500);
    window.addEventListener("resize", follow);
    return () => { clearInterval(timer); window.removeEventListener("resize", follow); };
  }, [mode]);
  const finish = (state: TourState) => { write(STATE_KEY, state); setMode("idle"); };
  if (mode === "offer") return (
    <aside className="guided-tour-offer" role="dialog" aria-label={t("Show what is where", "Pokaż, co jest gdzie")}>
      <span>{t("New: a short tour of what is where.", "Nowe: krótki przewodnik po tym, co jest gdzie.")}</span>
      <div className="guided-tour-actions">
        <button type="button" className="ui-link-button" onClick={() => finish("declined")}>{t("No thanks", "Nie, dziękuję")}</button>
        <GhostButton emphasis onClick={() => { setIndex(0); setMode("running"); }}>{t("Show what is where", "Pokaż, co jest gdzie")}</GhostButton>
      </div>
    </aside>
  );
  if (mode !== "running") return null;
  const steps = presentSteps(tourSteps(t), selector => targetRect(selector) !== null);
  const step = steps[Math.min(index, steps.length - 1)];
  const rect = step ? targetRect(step.target) : null;
  if (!step || !rect) return null;
  const position = bubblePosition(rect);
  const at = steps.indexOf(step);
  return <>
    <div className="guided-tour-ring" aria-hidden="true"
      style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }} />
    <aside className="guided-tour-bubble" role="dialog" aria-label={step.title} style={{ ...position, width: BUBBLE_W }}>
      <div className="guided-tour-head">
        <strong>{step.title}</strong>
        <span className="mono">{at + 1}/{steps.length}</span>
      </div>
      <p>{step.body}</p>
      <div className="guided-tour-actions">
        <button type="button" className="ui-link-button" onClick={() => finish("skipped")}>{t("Skip", "Pomiń")}</button>
        {step.last
          ? <GhostButton emphasis onClick={() => { finish("done"); onOpenUsage(); }}>{t("Open Usage", "Otwórz Zużycie")}</GhostButton>
          : <GhostButton emphasis onClick={() => setIndex(at + 1)}>{t("Next", "Dalej")}</GhostButton>}
      </div>
    </aside>
  </>;
}
