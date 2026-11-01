import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GuidedTour } from "./GuidedTour";
import { initialTourMode, presentSteps, tourSteps } from "../lib/guided-tour";
import { translateForLanguage, type MessageTranslator } from "../lib/i18n";

const t: MessageTranslator = (en, pl, values) => translateForLanguage("en", en, pl, values);

// TALK-001 D10/D13: the tour starts after consent, is offered once to an older installation, replays from "?",
// skips what is not on screen and ends at the screen with the first numbers.
describe("guided tour", () => {
  test("starts after consent, offers itself once to an installation without an answer, then stays quiet", () => {
    expect(initialTourMode(null, true)).toBe("running");
    expect(initialTourMode("done", true)).toBe("running");
    expect(initialTourMode(null, false)).toBe("offer");
    for (const answer of ["done", "skipped", "declined"]) expect(initialTourMode(answer, false)).toBe("idle");
  });
  test("a step whose element is not on screen is skipped, never shown floating", () => {
    const steps = tourSteps(t);
    const shown = presentSteps(steps, selector => selector !== ".subs-rail");
    expect(shown.map(step => step.target)).not.toContain(".subs-rail");
    expect(shown).toHaveLength(steps.length - 1);
  });
  test("the last step leads to Usage, where numbers appear without limit readings", () => {
    const last = tourSteps(t).at(-1)!;
    expect(last.last).toBe(true);
    expect(last.target).toBe('[data-nav="usage"]');
    expect(last.body).toContain("also without limit readings");
  });
  test("an installation with no remembered answer sees the offer, which blocks nothing", () => {
    const html = renderToStaticMarkup(<GuidedTour replay={0} onOpenUsage={() => {}} />);
    expect(html).toContain("guided-tour-offer");
    expect(html).toContain("Show what is where");
    expect(html).toContain("No thanks");
  });
});
