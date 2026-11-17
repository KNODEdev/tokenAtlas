import type { TimelineMarker } from "./codex-accounting";

function release(model: string, day: string, label: string, note: string, color: TimelineMarker["color"] = "violet"): TimelineMarker {
  return { id: `model:release:${model}`, day, label, note, color, visible: true };
}

const gpt62 = "Public release in ChatGPT Work, Codex and the API. https://learn.chatgpt.com/docs/whats-new#november-17-2026";
const claude52 = "Public Anthropic announcement. https://www.anthropic.com/claude-fable-and-mythos-5-2";

export const MODEL_RELEASE_MARKERS: Readonly<Partial<Record<string, readonly TimelineMarker[]>>> = {
  codex: [
    release("gpt-6.2-astra", "2026-11-17", "GPT-6.2 Astra", gpt62, "accent"),
    release("gpt-6.2-sol", "2026-11-17", "GPT-6.2 Sol", gpt62),
  ],
  claude: [
    release("claude-fable-5-2", "2026-11-09", "Claude Fable 5.2", claude52),
    release("claude-mythos-5-2", "2026-11-09", "Claude Mythos 5.2", claude52),
  ],
  gemini: [
    release("gemini-4-argon", "2026-10-13", "Gemini 4 Argon",
      "Public developer release. https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-4-argon/"),
    release("gemini-4-carbon", "2026-11-10", "Gemini 4 Carbon",
      "General availability in the Gemini API. https://aistudio.google.com/docs/changelog#11-10-2026"),
    release("gemini-4-hydrogen", "2026-11-12", "Gemini 4 Hydrogen",
      "General availability in the Gemini API. https://aistudio.google.com/docs/changelog#11-12-2026"),
  ],
};

export function isModelRelease(marker: TimelineMarker): boolean {
  return Object.values(MODEL_RELEASE_MARKERS).some(releases =>
    releases?.some(release => release.id === marker.id && release.day === marker.day));
}
