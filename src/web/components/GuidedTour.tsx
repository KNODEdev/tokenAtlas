import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { PENDING_KEY, STATE_KEY, initialTourMode, presentSteps, read, tourSteps, write, type TourMode, type TourState } from "../lib/guided-tour";
import { GhostButton } from "./ui";
import "./GuidedTour.css";

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

/**
 * A short tour of what is where (TALK-001 D10/D13): it starts by itself after the first-run consent, while the
 * import runs, and "?" in the header replays it. An installation that predates it gets one offer, once.
 * Bubbles sit beside their element and never cover the status bar, so the progress and Pause stay usable.
 */
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
    <aside className="guided-tour-offer" aria-label={t("Show what is where", "Pokaż, co jest gdzie")}>
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
    <aside className="guided-tour-bubble" aria-label={step.title} style={{ ...position, width: BUBBLE_W }}>
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
