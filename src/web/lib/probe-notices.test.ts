import { afterEach, expect, test } from "bun:test";
import { setLanguage } from "./i18n";
import { machineTrail, probeCopy, probeIssueText, probeMachineRows, shortError } from "./probe";
import { probeNoticeLines } from "./probe-notices";
import { sourceErrorText } from "../components/SourceHealthPanel";
import type { RosterProbe } from "./api";
import type { ProbeNotice } from "../../shared/probe-error";
import type { SourceHealthRow } from "../../shared/source-health";

afterEach(() => setLanguage("en"));

// Local times, so the clock reads 03:20 / 01:19 in any time zone.
const now = new Date(2026, 9, 9, 14, 0).getTime();
const at = (hour: number, minute: number, day = 9) => new Date(2026, 9, day, hour, minute).toISOString();
const EXPIRED = "[login-expired] Claude sign-in expired: the token refresh was refused (invalid_grant, HTTP 400); run `claude` and sign in (/login).";
const MISMATCH = "[login-mismatch] Claude OAuth identity does not match this profile (account …abcd, expected …0001); usage was not attributed.";

test("an expired sign-in reads as one sentence in both languages", () => {
  setLanguage("pl");
  expect(probeIssueText({ provider: "claude", machine: "EXAMPLE-LAPTOP-A", code: "login-expired", since: at(3, 20), nowMs: now }).text)
    .toBe("Claude na EXAMPLE-LAPTOP-A: logowanie wygasło, odczyty limitu wstrzymane od 03:20 — uruchom `claude` w terminalu i zaloguj się (/login)");
  setLanguage("en");
  const en = probeIssueText({ provider: "claude", machine: "EXAMPLE-LAPTOP-A", code: "login-expired", since: at(3, 20), nowMs: now });
  expect(en.head).toBe("Claude on EXAMPLE-LAPTOP-A: sign-in expired");
  expect(en.tail).toMatch(/^limit readings paused since 03:20( AM)? — run `claude` in a terminal and sign in \(\/login\)$/);
  // Another day names the date too.
  expect(probeIssueText({ provider: "claude", machine: "PC", code: "login-expired", since: at(23, 5, 8), nowMs: now }).tail)
    .toContain("since 10/08 11:05 PM");
});

test("a profile signed in to another account has its own sentence", () => {
  setLanguage("pl");
  expect(probeIssueText({ provider: "claude", machine: "PC", code: "login-mismatch", since: at(1, 19), nowMs: now }).text)
    .toBe("Claude na PC: zalogowano inne konto, odczyty limitu wstrzymane od 01:19 — zaloguj się na konto tej subskrypcji (`claude`, /login)");
  setLanguage("en");
  expect(probeIssueText({ provider: "claude", machine: "PC", code: "login-mismatch", since: null, nowMs: now }).text)
    .toBe("Claude on PC: signed in to another account, no limit reading yet — sign in to this subscription's account (`claude`, /login)");
});

const notice = (overrides: Partial<ProbeNotice> = {}): ProbeNotice => ({ provider: "claude", subject: "claude-1", account: "one@example.com",
  machine: "EXAMPLE-LAPTOP-A", code: "login-expired", since: at(1, 19), failed_at: at(13, 50), ...overrides });

test("notice lines name the account only when two accounts of one vendor need telling apart", () => {
  expect(probeNoticeLines([notice()], now).map(line => line.head)).toEqual(["Claude on EXAMPLE-LAPTOP-A: sign-in expired"]);
  expect(probeNoticeLines([notice(), notice({ machine: "EXAMPLE-MAIN" })], now).map(line => line.head))
    .toEqual(["Claude on EXAMPLE-LAPTOP-A: sign-in expired", "Claude on EXAMPLE-MAIN: sign-in expired"]);
  expect(probeNoticeLines([notice(), notice({ subject: "claude-2", account: null })], now).map(line => line.head))
    .toEqual(["Claude (one@example.com) on EXAMPLE-LAPTOP-A: sign-in expired", "Claude (claude-2) on EXAMPLE-LAPTOP-A: sign-in expired"]);
  expect(probeNoticeLines(null)).toEqual([]);
});

const probe = (last_error: string, ok = at(1, 19), failed = at(13, 50)): RosterProbe => ({ provider: "claude", subject: "claude-1",
  state: "stale", fresh_minutes: 30, reading: { ts: ok, age_minutes: 761, machine: "EXAMPLE-LAPTOP-A" },
  machines: [{ machine: "EXAMPLE-LAPTOP-A", last_ok_ts: ok, last_error_ts: failed, last_error }] });

test("the card's probe line shows the sentence instead of the clipped mixed-language error", () => {
  const copy = probeCopy(probe(EXPIRED), now);
  expect(copy.trail).toMatch(/^Claude on EXAMPLE-LAPTOP-A: sign-in expired, limit readings paused since 01:19( AM)? — run `claude` in a terminal and sign in \(\/login\)$/);
  expect(copy.trail).not.toContain("[login-expired]");
  expect(copy.detail).toContain(copy.trail);
  setLanguage("pl");
  expect(probeCopy(probe(EXPIRED), now).trail)
    .toBe("Claude na EXAMPLE-LAPTOP-A: logowanie wygasło, odczyty limitu wstrzymane od 01:19 — uruchom `claude` w terminalu i zaloguj się (/login)");
  // An uncoded failure keeps the old trail; a coded one that a later success superseded is only named.
  setLanguage("en");
  expect(machineTrail(probe("HTTP 500").machines[0]!, now, "claude")).toContain("probe error since 10/09 (HTTP 500)");
  expect(shortError(MISMATCH)).toBe("signed in to another account");
  expect(probeMachineRows([probe(EXPIRED, at(13, 55))], now)[0]!.error).toBe("last error 10/09 (sign-in expired)");
});

test("Data sources and the source health details show the same sentence", () => {
  const rows = probeMachineRows([probe(MISMATCH)], now);
  expect(rows[0]!.failing).toBe(true);
  expect(rows[0]!.error).toMatch(/^Claude on EXAMPLE-LAPTOP-A: signed in to another account, limit readings paused since 01:19/);
  const source = { vendor: "claude", machine: "EXAMPLE-LAPTOP-A", last_meter: at(1, 19), error: EXPIRED } as SourceHealthRow;
  setLanguage("pl");
  expect(sourceErrorText(source)).toMatch(/^Claude na EXAMPLE-LAPTOP-A: logowanie wygasło, odczyty limitu wstrzymane od (\d\d\.\d\d )?\d\d:\d\d — uruchom `claude`/);
  expect(sourceErrorText({ ...source, error: "Meter reading failed" })).toBe("Meter reading failed");
  expect(sourceErrorText({ ...source, error: null })).toBeNull();
});

test("a sign-in that could not be saved has its own sentence in both languages", () => {
  setLanguage("pl");
  expect(probeIssueText({ provider: "claude", machine: "PC", code: "login-save-failed", since: at(3, 20), nowMs: now }).text)
    .toBe("Claude na PC: nie udało się zapisać odnowionego logowania, odczyty limitu wstrzymane od 03:20 — uruchom `claude` (w razie potrzeby zaloguje ponownie, /login)");
  setLanguage("en");
  expect(probeIssueText({ provider: "claude", machine: "PC", code: "login-save-failed", since: null, nowMs: now }).text)
    .toBe("Claude on PC: the renewed sign-in could not be saved, no limit reading yet — run `claude` (it signs in again if needed, /login)");
  expect(shortError("[login-save-failed] Claude sign-in could not be saved: …")).toBe("sign-in not saved");
});

test("a profile never signed in reads as not connected, with the expired remedy", () => {
  const MISSING = "[login-missing] Claude Code is not signed in in this profile (no .credentials.json); sign in to read the limits.";
  expect(probeIssueText({ provider: "claude", machine: "PC", code: "login-missing", since: null, nowMs: now }).text)
    .toBe("Claude on PC: not connected for limit readings, no limit reading yet — run `claude` in a terminal and sign in (/login)");
  setLanguage("pl");
  expect(probeIssueText({ provider: "claude", machine: "PC", code: "login-missing", since: null, nowMs: now }).text)
    .toBe("Claude na PC: brak połączenia do odczytu limitów, brak odczytu limitu — uruchom `claude` w terminalu i zaloguj się (/login)");
  expect(shortError(MISSING)).toBe("brak połączenia");
  setLanguage("en");
  const never: RosterProbe = { ...probe(MISSING), state: "none", reading: null,
    machines: [{ machine: "EXAMPLE-LAPTOP-A", last_ok_ts: null, last_error_ts: at(13, 50), last_error: MISSING }] };
  const copy = probeCopy(never, now);
  expect(copy.trail).toBe("Claude on EXAMPLE-LAPTOP-A: not connected for limit readings, no limit reading yet — run `claude` in a terminal and sign in (/login)");
});
