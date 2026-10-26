import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Exact restoration requested on 2026-09-06; initial baseline: master@69b1510.
// Updating these visual baselines requires explicit user approval of the layout.
// 2026-09-08: user requested moving tile styles into global CSS; geometry is unchanged.
// 2026-09-09: user requested EN/PL localization and the upper-right language switch.
// Reviewed changes preserve the Overview structure, rails, sections and styles.
// 2026-09-11: reviewed account identity labels and live-read refresh wiring;
// the merged App source preserves control placement and the Overview layout.
// 2026-09-13: user requested applying docs/design/tokenAtlas.dc.html exactly: full-height
// dark navigation bar with the brand, top bar beside it, screen title bar from the design.
// 2026-09-15: approved Settings source workflow (docs/design/vocabulary.md), including
// hiding analysis-only selectors there; commit 22d9b5e also decouples prepared reads.
// main@7291ed2 only wires the existing privacy shield; its JSX and style imports are unchanged.
// 2026-09-17: startup waits for a declared account and its roster contract before reading
// history. Only data selection/hooks changed; every JSX subtree and style import is preserved.
// 2026-09-18: user requested visible rebuild progress after reset/restart instead
// of the loading skeleton, then elapsed-time loaders on subscription switches.
// Data readiness no longer waits for an unrelated provider roster; ready layouts are preserved.
// 2026-09-20: user requested that picking a closed window in the rail actually report that
// window. Only the Claude overview's reported instant is wired through; no JSX subtree,
// control placement or style import changed.
// 2026-09-23: user accepted the header activity indicator (AppActivity replacing ReportFreshness,
// with sync-status timeout) introduced by the register v8 work.
// 2026-09-25: user approved a "Periods" button right after the subscription selector that opens
// the selected account's periods in a drawer; no other control moved.
// 2026-09-26: user approved the Codex window status block (docs/design/window-status-mockup.html)
// above Plan windows, replacing the "Most urgent" card and the repeated usage/forecast tiles.
// 2026-09-26: user approved docs/design/overview-tabs-mockup.html: tabs under the status block
// (Forecast and budget, Models and traffic, Window history, Data and calibration).
// 2026-09-26: the same approved mockup's Claude variant: Claude's Overview renders its own status
// block from the rail windows, so App hides the separate counters card for Claude as for Codex.
// 2026-09-26: user approved docs/ui-audit-2026-09-26.md; the History subtitle counts limit windows
// when an account has no registered cycles (Claude showed "0 cycles · window 0m"). Text only.
// 2026-09-26: the same approval, decision 5: the header's window selector and %/tokens/$ tabs are
// hidden on Capacity only (it has its own counter and unit switch); every other screen is unchanged.
// 2026-09-26: the same approval, History and Compare findings and decisions 12-13
// (docs/design/audit-history-compare-mockup.html): Codex shows one comparison instead of two stacked,
// the window rail picks Compare's windows, the Compare subtitle no longer promises 0-100% curves, and
// Claude's Overview window table links to History. No control moved; the Overview gains only that link.
// 2026-09-27: the same approval, decisions 1 and 7 (docs/design/audit-analytics-patterns-mockup.html):
// Analytics and Patterns render as one tabbed screen with one navigation entry; for Claude and Business it
// shows its own short note instead of the generic empty states. Header, rails and the Overview are unchanged.
// 2026-09-27: user approved the Claude closed-window fixes: a picked window or counter segment is reported
// for its exact bounds instead of an instant inside it. Only that wiring changed; no JSX subtree moved.
// 2026-09-27: the 26.09 approval, decisions 2 and 14 (docs/design/audit-models-events-projects-mockup.html):
// App keeps the target Usage events was opened with (subscription, dates, model) and passes History's
// window panels a link to it; the cycle drawer shows that link on History only. No control moved.
// 2026-09-27: the 26.09 approval, decision 16 (docs/design/audit-settings-sources-mockup.html): Subskrypcje no
// longer edits plan stages, so index.css loses only the removed stage drawer's rules. No Overview rule changed.
// 2026-09-27: the same approval, decisions 3 and 4: App's Settings and Data sources subtitles follow the renamed
// "Profiles and computers" tab and the Data sources screen without its Accounts tab. Text only; no JSX subtree moved.
// 2026-09-30: user requested one permanent status bar under the header instead of the appearing and
// disappearing sync bar, the header activity chip, the "sync error/partial" badges and the startup,
// remap and rebuild cards; the bar also carries the rebuild's reports step. Nothing else moved.
// 2026-10-07: user approved docs/design/model-speed-mockup.html: a Speed screen under Models. App only routes it,
// gives it a subtitle and shows the subscription selector (with Periods) without the project, window and unit
// controls there, and without the shell's cycle-series errors it does not read. Every other screen and the Overview
// are unchanged.
// 2026-10-07: user approved "All" on Speed (models of every chosen subscription, a drawer to choose them): App hands
// Speed the roster cards it already gives Insights and Projects. Nothing else changed.
// 2026-10-08: user requested one hue per vendor everywhere (Anthropic orange, OpenAI blue, Gemini green, Grok grey):
// tokens.css changes only --gemini (blue to green) and --glm (green to fuchsia, so it does not clash with Gemini).
// 2026-10-08: user approved the Settings subtitle following its three tabs ("Konta, komputery i dane, cenniki").
// Text only; no JSX subtree or control moved.
// 2026-10-08: user approved the built-in no-subscription plan ("none", shown as "Brak abonamentu"/"No subscription"):
// the subscription picker labels and the header's account tooltip name it in words instead of the raw "none". Text only.
// 2026-10-09: user approved the package notices mockup (docs/credit-notices-2026-10-09.md §6): App only hands the
// status bar a handler that selects a subscription for "Otwórz subskrypcję". No JSX subtree or control moved.
// 2026-10-09: user approved the paper-atlas restyle ("nowy jest ok"), docs/design/paper-atlas.md: the product page's
// language (cool paper, ink, one sea-blue accent, Plex Sans/Mono, Kalam only in the wordmark, no capitals, no nested
// frames, no side stripes or offset shadows) in tokens.css/index.css; App's subscription picker (grouped list instead of
// a native select) and a compact subscription rail from 1100 px instead of tiles above the content (useBreakpoint);
// VendorOverview drops the frame around an empty state. Structure, section order and navigation are unchanged.
// 2026-10-09: user approved the map-sheet logo with a Plex Sans wordmark ("tak"); Kalam is retired, so tokens.css
// loses only its unused Kalam @font-face. No token value, layout or control changed.
// 2026-10-10: user approved a muted violet ("tak"): --violet #6b5ba8 -> #71669d (dark #b6a8ea -> #bdb3df), same hue
// and lightness, less saturation. No other token, layout or control changed.
// 2026-10-11: user requested a view before the application ("panel na środku, wokół pusto, ustawienia i wyjaśnienia obok"):
// App renders FirstRun (screens/FirstRun.tsx) instead of the stacked setup cards when setup is needed, and also while a
// fresh database waits for its folders to be confirmed. The shell and the Overview are unchanged.
// 2026-10-14: user approved ("ok rób obie") dropping the Overview section header's own pencil rule, so the page tabs'
// double rule is the one strong line; index.css loses only that border and its padding. No control moved.
// 2026-10-15: user approved opening the shared KPI strip everywhere, the Overview included ("Otworzyć wszędzie"):
// index.css draws it between dashed rules like Facts and aligns its first cell with the content edge. No control moved.
// 2026-10-20: user assigned the IA-2026-10-19 v1.1 migration ("po prostu całość zrób, zobaczę efekt"):
// App.tsx routes the 6 + 2 menu, page tabs and views, the new Value/Usage views, the shell columns per IA-41 and
// the scope line with "Compare windows" (docs/ia/2026-10-19). Its baseline is the reviewed source after that change;
// the earlier strip functions for authorized wiring are folded into it.
// 2026-10-20, same assignment (01 OV): VendorOverview drops its Window history tab, whose owner is Limits → Limit
// windows, and links there instead. The other approved files are unchanged.
const baseline = [
  ["src/web/App.tsx", "a5f51ca61cc564e1e84816fa4d14bf038373cb14"],
  ["src/web/main.tsx", "70d74c18d6c784da3aca991d787a36348bc8efc0"],
  ["src/web/components/AppHeader.tsx", "45ebafbcd646a4711896241c81328b370150a290"],
  ["src/web/components/VendorOverview.tsx", "9cc00f0999efbcc272ffb7678d850ed24f75d0e3"],
  ["src/web/lib/useBreakpoint.ts", "11508f856921167d13aaed61d604523b6fcce6d9"],
  ["src/web/index.css", "1454091035a126c654f1c0494685f0e3de2b87c4"],
  ["src/web/tokens.css", "73ad4621e31e3eaa19ea651b3dc03f3dd0a436b8"],
] as const;
const root = path.resolve(import.meta.dir, "../..");
describe("user-approved Overview layout", () => {
  test.each(baseline)("%s matches the approved source", (file, expected) => {
    // Git may check text out as CRLF on Windows. Hash the canonical Git LF
    // content; do not normalize any other whitespace or accept a changed UI.
    const source=fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    const bytes = Buffer.from(source);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    expect(hash).toBe(expected);
  });
  test("no replacement entry or override stylesheet can be mounted", () => {
    expect(fs.existsSync(path.join(root, "src/web/CurrentApp.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src/web/current.css"))).toBe(false);
    const main = fs.readFileSync(path.join(root, "src/web/main.tsx"), "utf8");
    expect(main).toContain('import { App } from "./App"');
    expect(main).not.toContain("CurrentApp");
  });
});
