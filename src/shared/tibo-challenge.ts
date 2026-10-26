/** Curated announcements, separate from account reset evidence and measured outcomes. */
export const TIBO_SOURCE = "https://x.com/thsottiaux/status/2106845241357824205";
export const TIBO_RECORD = "https://didcodexreset.com/oct28.html";
export const TIBO_REVIEWED = "2026-10-18";
export const TIBO_REVIEWED_AT = "2026-10-18T14:51:11Z";
export const TIBO_REVIEWED_THROUGH_DAY = 14;
export const TIBO_ZONE = "America/Los_Angeles";
export const TIBO_SPEED_CLAIM = {
  before: 30, after: 50,
  source: "https://x.com/thsottiaux/status/2107159119107146237",
  clarification: "https://x.com/thsottiaux/status/2107295089416708515",
  record: "https://codex-reset.com/tibo/x/2026-10-05",
} as const;
export interface TiboPromise {
  day: number; kind: "improvement" | "reset" | "banked";
  state: "released" | "announced" | "withdrawn";
  en: string; pl: string; source: string; at?: string;
  example?: { en: string; pl: string };
}
const post = (id: string) => `https://x.com/thsottiaux/status/${id}`;
export const TIBO_PROMISES: readonly TiboPromise[] = [
  { day: 1, kind: "improvement", state: "released", en: "Default speed ≈ +50%", pl: "Domyślna szybkość ≈ +50%", source: post("2107158998495748264"),
    example: { en: "Astra and Sol through Sign in with ChatGPT; default speed, no settings change.", pl: "Astra i Sol przez Sign in with ChatGPT; domyślna szybkość, bez zmiany ustawień." } },
  { day: 1, kind: "improvement", state: "released", en: "Speed clarification · 30 → 50 tok/s", pl: "Doprecyzowanie szybkości · 30 → 50 tok/s", source: TIBO_SPEED_CLAIM.source },
  { day: 2, kind: "improvement", state: "released", en: "Free auto-review · API · meeting notes", pl: "Bezpłatne auto-review · API · notatki", source: post("2107575657014468879") },
  { day: 2, kind: "reset", state: "released", en: "Full reset", pl: "Pełny reset", source: post("2107676072871600470"), at: "2026-10-07T03:35:00Z" },
  { day: 3, kind: "improvement", state: "released", en: "Codex cloud", pl: "Codex cloud", source: post("2108084615349170480") },
  { day: 3, kind: "improvement", state: "released", en: "GPT-6 in Chat", pl: "GPT-6 w Chat", source: post("2107913674593644711") },
  { day: 3, kind: "banked", state: "released", en: "Banked reset", pl: "Reset do wykorzystania", source: post("2108040921044639779"), at: "2026-10-08T03:44:00Z" },
  { day: 4, kind: "improvement", state: "released", en: "Instant steering · Sol ultrafast", pl: "Natychmiastowy steering · Sol ultrafast", source: post("2108275041276420573") },
  { day: 5, kind: "improvement", state: "released", en: "Composer predictions", pl: "Podpowiedzi composera", source: post("2108645667451318747") },
  { day: 5, kind: "improvement", state: "released", en: "Mobile dot", pl: "Dot w telefonie", source: post("2108646052178092403") },
  { day: 6, kind: "reset", state: "released", en: "Full reset", pl: "Pełny reset", source: post("2109132167112782291"), at: "2026-10-11T04:01:00Z" },
  { day: 7, kind: "improvement", state: "released", en: "Sol default context · 500k", pl: "Domyślny kontekst Sol · 500k", source: post("2109430343346581527"),
    example: { en: "Default context: 272k → 500k; a manual override can still reach 1M.", pl: "Domyślny kontekst: 272k → 500k; ręczne ustawienie nadal pozwala osiągnąć 1M." } },
  { day: 8, kind: "reset", state: "released", en: "Full reset", pl: "Pełny reset", source: post("2109873287853707513"), at: "2026-10-13T05:06:00Z" },
  { day: 9, kind: "improvement", state: "released", en: "App state on disk ≈ −60%", pl: "Stan aplikacji na dysku ≈ −60%", source: post("2110151780478927344") },
  { day: 10, kind: "reset", state: "released", en: "Full reset", pl: "Pełny reset", source: post("2110618732666257557"), at: "2026-10-15T06:28:00Z" },
  { day: 11, kind: "improvement", state: "released", en: "Fewer model-at-capacity errors", pl: "Mniej błędów model-at-capacity", source: post("2110750421367287996") },
  { day: 12, kind: "improvement", state: "released", en: "More effective usage · context cache", pl: "Więcej efektywnego użycia · cache kontekstu", source: post("2111244596131111253"),
    example: { en: "Context shared across subagents, longer cache retention and improved routing.", pl: "Współdzielenie kontekstu między subagentami, dłuższe utrzymanie cache i lepszy routing." } },
  { day: 13, kind: "reset", state: "released", en: "Full reset", pl: "Pełny reset", source: post("2111566005684289735"), at: "2026-10-17T21:12:21Z",
    example: { en: "Completion confirmed after the Day 13 reset announcement.", pl: "Zakończenie potwierdzone po ogłoszeniu resetu na dzień 13." } },
];

export function tiboDate(day: number): string {
  return new Date(Date.UTC(2026, 9, 4 + day)).toISOString().slice(0, 10);
}
const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: TIBO_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
export function tiboLocalDate(ms: number): string {
  const parts = pacific.formatToParts(ms), value = (type: string) => parts.find(p => p.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
/** The last campaign day crosses DST; never represent Pacific time as a fixed UTC offset. */
export function tiboMidnight(date: string): number {
  const utc = Date.parse(date), zone = new Intl.DateTimeFormat("en-US", { timeZone: TIBO_ZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let ms = utc;
  for (let i = 0; i < 3; i++) {
    const parts = zone.formatToParts(ms), n = (type: string) => Number(parts.find(p => p.type === type)!.value);
    ms += utc - Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  }
  return ms;
}
export const tiboBounds = (day: number) => ({ from: tiboMidnight(tiboDate(day)), until: tiboMidnight(tiboDate(day + 1)) });
export function tiboDayStatus(day: number, nowMs: number): "recorded" | "unconfirmed" | "pending" | "future" {
  const bounds = tiboBounds(day);
  if (nowMs < bounds.from) return "future";
  if (TIBO_PROMISES.some(p => p.day === day)) return "recorded";
  return nowMs < bounds.until ? "pending" : "unconfirmed";
}
/** Public events depend on the reviewed source record, never on local accounts or counters. */
export function tiboPublicDay(day: number, nowMs: number) {
  const calendar = tiboDayStatus(day, nowMs);
  const promises = calendar === "future" ? [] : TIBO_PROMISES.filter(p => p.day === day);
  const reset = promises.some(p => p.kind === "reset") ? "full" : promises.some(p => p.kind === "banked") ? "banked"
    : calendar === "future" ? "future" : day <= TIBO_REVIEWED_THROUGH_DAY && tiboBounds(day).until <= nowMs ? "none" : "unknown";
  const states = new Set(promises.map(p => p.state));
  const state = !promises.length ? calendar : states.size > 1 ? "mixed" : promises[0]!.state;
  return { promises, reset, state } as const;
}
