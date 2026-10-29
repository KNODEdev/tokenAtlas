import type { ProbeMachineStatus, ProbeReadingState, RosterProbe } from "./api";
import { getLocale, translate } from "./i18n";
import { probeErrorCode, type ProbeErrorCode } from "../../shared/probe-error";

function localizedNumber(value: number, fractionDigits = 0): string {
  return value
    .toLocaleString(getLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
    .replace(/\u00a0/g, " ");
}
function unknownMachine(): string {
  return translate("unknown machine", "maszyna nieznana");
}

/** „przed chwilą / 42 min temu / 15,3 h temu / 4 dni temu" — one age wording for every probe line. */
export function probeAge(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return translate("just now", "przed chwilą");
  if (minutes < 60) {
    const value = localizedNumber(Math.round(minutes));
    return translate("{0} min ago", `${value} min temu`, [value]);
  }
  const hours = minutes / 60;
  if (hours < 48) {
    const value = localizedNumber(hours, 1);
    return translate("{0} h ago", `${value} h temu`, [value]);
  }
  const value = localizedNumber(Math.round(hours / 24));
  return translate("{0} days ago", `${value} dni temu`, [value]);
}

function ageMinutes(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? (nowMs - ts) / 60_000 : null;
}

function dayDot(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(getLocale(), { day: "2-digit", month: "2-digit" }).format(d);
}

/** A machine with no name is a sample from before the cross-machine journal, not an anonymous PC. */
export function machineLabel(machine: string | null): string {
  return machine ?? unknownMachine();
}

/** A vendor message is a hint behind our own wording, never the wording itself: one line, clipped. */
export function shortError(error: string | null | undefined): string | null {
  if (!error) return null;
  const code = probeErrorCode(error);
  if (code === "login-expired") return translate("sign-in expired", "logowanie wygasło");
  if (code === "login-mismatch") return translate("signed in to another account", "zalogowano inne konto");
  if (code === "login-save-failed") return translate("sign-in not saved", "logowanie niezapisane");
  if (code === "login-missing") return translate("not connected", "brak połączenia");
  const flat = error.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > 70 ? `${flat.slice(0, 69)}…` : flat;
}

function errorIsNewer(m: ProbeMachineStatus): boolean {
  return m.last_error_ts != null && (m.last_ok_ts == null || m.last_error_ts > m.last_ok_ts);
}

const VENDOR_NAMES: Record<string, string> = { claude: "Claude", anthropic: "Claude", codex: "Codex", openai: "Codex",
  gemini: "Gemini", grok: "Grok", glm: "GLM" };
/** „03:20" today, „08.10 03:20" on another day. */
function clockTime(iso: string, nowMs: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const time = at.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date(nowMs).toDateString() ? time : `${dayDot(iso)} ${time}`;
}
/** A probe failure the user fixes, as one sentence: `head` names who and what, `tail` since when and the remedy. */
export interface ProbeIssueText { head: string; tail: string; text: string }
/**
 * „Claude on EXAMPLE-LAPTOP-A: sign-in expired, limit readings paused since 03:20 — run `claude` in a terminal and sign in (/login)".
 * `since` is the last successful reading on that computer; `account` tells several accounts of one vendor apart.
 */
export function probeIssueText({ provider, machine, code, since, account = null, nowMs = Date.now() }: {
  provider: string; machine: string | null; code: ProbeErrorCode; since: string | null; account?: string | null; nowMs?: number;
}): ProbeIssueText {
  const vendor = VENDOR_NAMES[provider.toLowerCase()] ?? provider;
  const who = `${vendor}${account ? ` (${account})` : ""}`;
  const where = machineLabel(machine);
  const claude = vendor === "Claude";
  const head = code === "login-mismatch"
    ? translate("{0} on {1}: signed in to another account", `${who} na ${where}: zalogowano inne konto`, [who, where])
    : code === "login-save-failed"
      ? translate("{0} on {1}: the renewed sign-in could not be saved", `${who} na ${where}: nie udało się zapisać odnowionego logowania`, [who, where])
    : code === "login-missing"
      ? translate("{0} on {1}: not connected for limit readings", `${who} na ${where}: brak połączenia do odczytu limitów`, [who, where])
      : translate("{0} on {1}: sign-in expired", `${who} na ${where}: logowanie wygasło`, [who, where]);
  const paused = since
    ? translate("limit readings paused since {0}", `odczyty limitu wstrzymane od ${clockTime(since, nowMs)}`, [clockTime(since, nowMs)])
    : translate("no limit reading yet", "brak odczytu limitu");
  const remedy = code === "login-mismatch"
    ? claude ? translate("sign in to this subscription's account (`claude`, /login)", "zaloguj się na konto tej subskrypcji (`claude`, /login)")
      : translate("sign in to this subscription's account", "zaloguj się na konto tej subskrypcji")
    : code === "login-save-failed"
      ? claude ? translate("run `claude` (it signs in again if needed, /login)", "uruchom `claude` (w razie potrzeby zaloguje ponownie, /login)")
        : translate("sign in again", "zaloguj się ponownie")
    : claude ? translate("run `claude` in a terminal and sign in (/login)", "uruchom `claude` w terminalu i zaloguj się (/login)")
      : translate("sign in again", "zaloguj się ponownie");
  const tail = `${paused} — ${remedy}`;
  return { head, tail, text: `${head}, ${tail}` };
}
/** The sentence for a machine whose newest reading failed with a code the user fixes; null for any other state. */
function machineIssue(m: ProbeMachineStatus, provider: string | undefined, nowMs: number): string | null {
  const code = provider && errorIsNewer(m) ? probeErrorCode(m.last_error) : null;
  return code ? probeIssueText({ provider: provider!, machine: m.machine, code, since: m.last_ok_ts, nowMs }).text : null;
}

/** „EXAMPLE-MAIN — błąd sondy od 30.08 (auth.json missing)" */
export function machineTrail(m: ProbeMachineStatus, nowMs = Date.now(), provider?: string): string {
  const name = machineLabel(m.machine);
  const issue = machineIssue(m, provider, nowMs);
  if (issue) return issue;
  if (errorIsNewer(m)) {
    const detail = shortError(m.last_error);
    return translate(
      "{0} - probe error since {1}{2}",
      `${name} — błąd sondy od ${dayDot(m.last_error_ts)}${detail ? ` (${detail})` : ""}`, [name, dayDot(m.last_error_ts), detail ? ` (${detail})` : ""],
    );
  }
  const okAge = ageMinutes(m.last_ok_ts, nowMs);
  if (okAge != null) {
    const age = probeAge(okAge);
    return translate("{0} - last success {1}", `${name} — ostatni sukces ${age}`, [name, age]);
  }
  return translate("{0} - no samples", `${name} — brak próbek`, [name]);
}

export function machinesTrail(machines: ProbeMachineStatus[], nowMs = Date.now(), provider?: string): string {
  return machines.map((m) => machineTrail(m, nowMs, provider)).join("; ");
}

/** The three card states as text: a headline, the per-machine trail behind it, and one tooltip sentence. */
export interface ProbeCopy {
  state: ProbeReadingState;
  /** Compact card copy; machine identity stays in `line` and `detail`. */
  status: string;
  line: string;
  /** Empty when the headline already says everything (a fresh reading). */
  trail: string;
  detail: string;
}

export function probeCopy(probe: RosterProbe, nowMs = Date.now()): ProbeCopy {
  const trail = machinesTrail(probe.machines, nowMs, probe.provider);
  if (probe.state === "none") {
    const line = translate(
      "no computer is reading this limit",
      "żaden komputer nie odczytuje tego limitu",
    );
    const body = trail === ""
      ? translate("sign in to this provider's CLI on a computer to start readings", "zaloguj się w CLI tego dostawcy na komputerze, aby zacząć odczyty")
      : trail;
    return { state: "none", status: line, line, trail: body, detail: `${line}: ${body}.` };
  }
  const age = probeAge(probe.reading?.age_minutes ?? null);
  const where = machineLabel(probe.reading?.machine ?? null);
  if (probe.state === "fresh") {
    return {
      state: "fresh",
      status: translate("reading {0}", `pomiar ${age}`, [age]),
      line: `${age} · ${where}`,
      trail: "",
      detail: translate(
        "Percentage read from the account {0} by {1}; freshness threshold is {2} min.",
        `Procent odczytany z konta ${age} przez ${where}; próg świeżości to ${localizedNumber(probe.fresh_minutes)} min.`, [age, where, localizedNumber(probe.fresh_minutes)],
      ),
    };
  }
  const line = translate("last reading {0} from {1}", `ostatni odczyt ${age} z ${where}`, [age, where]);
  return {
    state: "stale",
    status: translate("last reading {0}", `ostatni pomiar ${age}`, [age]),
    line,
    trail,
    detail: translate(
      "{0}; freshness threshold is {1} min{2}.",
      `${line}; próg świeżości to ${localizedNumber(probe.fresh_minutes)} min${trail === "" ? "" : `. ${trail}`}.`, [line, localizedNumber(probe.fresh_minutes), trail === "" ? "" : `. ${trail}`],
    ),
  };
}

/** One row per (provider, subject, machine) for the Sources screen. */
export interface ProbeMachineRow {
  key: string;
  provider: string;
  subject: string;
  machine: string;
  ok: string;
  error: string | null;
  failing: boolean;
}

export function probeMachineRows(probes: RosterProbe[], nowMs = Date.now()): ProbeMachineRow[] {
  const rows: ProbeMachineRow[] = [];
  for (const probe of probes) {
    const machines: ProbeMachineStatus[] =
      probe.machines.length > 0
        ? probe.machines
        : [{ machine: null, last_ok_ts: null, last_error_ts: null, last_error: null }];
    for (const m of machines) {
      const okAge = ageMinutes(m.last_ok_ts, nowMs);
      const detail = shortError(m.last_error);
      const issue = machineIssue(m, probe.provider, nowMs);
      rows.push({
        key: `${probe.provider}/${probe.subject}/${m.machine ?? ""}`,
        provider: probe.provider,
        subject: probe.subject,
        machine: m.machine ?? `${unknownMachine()} (${translate("older samples", "starsze próbki")})`,
        ok:
          okAge == null
            ? translate("no successful reading", "brak sukcesu")
            : translate("last success {0}", `ostatni sukces ${probeAge(okAge)}`, [probeAge(okAge)]),
        error:
          m.last_error_ts == null
            ? null
            : issue ?? translate(
                "last error {0}{1}",
                `ostatni błąd ${dayDot(m.last_error_ts)}${detail ? ` (${detail})` : ""}`, [dayDot(m.last_error_ts), detail ? ` (${detail})` : ""],
              ),
        failing: errorIsNewer(m),
      });
    }
  }
  return rows;
}
