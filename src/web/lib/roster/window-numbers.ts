import type { RosterAccount } from "../api";
import { translate } from "../i18n";
import { freshnessLabel } from "./presentation";

export function usageWindowNumbers(input: {
  usedPercent: number | null;
  startsAt?: string | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  nowMs?: number;
}): {
  used: number | null;
  elapsed: number | null;
  remainingHours: number | null;
  resetIso: string | null;
  ppAhead: number | null;
  paceRatio: number | null;
} {
  const nowMs = input.nowMs ?? Date.now();
  const resetMs = input.resetsAt == null ? NaN : new Date(input.resetsAt).getTime();
  const declaredStartMs = input.startsAt == null ? NaN : new Date(input.startsAt).getTime();
  const derivedStartMs = Number.isFinite(resetMs) && input.windowMinutes != null && input.windowMinutes > 0
    ? resetMs - input.windowMinutes * 60_000
    : NaN;
  const startMs = Number.isFinite(declaredStartMs) ? declaredStartMs : derivedStartMs;
  const windowMs = Number.isFinite(resetMs) && Number.isFinite(startMs) && resetMs > startMs ? resetMs - startMs : NaN;
  const elapsed = Number.isFinite(windowMs)
    ? Math.max(0, Math.min(100, ((nowMs - startMs) / windowMs) * 100))
    : null;
  const ppAhead = input.usedPercent != null && elapsed != null ? input.usedPercent - elapsed : null;
  return {
    used: input.usedPercent,
    elapsed,
    remainingHours: Number.isFinite(resetMs) ? Math.max(0, (resetMs - nowMs) / 3_600_000) : null,
    resetIso: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
    ppAhead,
    paceRatio: input.usedPercent != null && elapsed != null && elapsed > 0 ? input.usedPercent / elapsed : null,
  };
}
export function liveNumbers(live: NonNullable<RosterAccount["live"]>): {
  used: number;
  elapsed: number | null;
  remainingHours: number | null;
  resetIso: string | null;
} {
  const numbers = usageWindowNumbers({
    usedPercent: live.used_percent,
    resetsAt: live.resets_at == null ? null : new Date(live.resets_at * 1000).toISOString(),
    windowMinutes: live.window_minutes,
  });
  return {
    used: numbers.used!,
    elapsed: numbers.elapsed,
    remainingHours: numbers.remainingHours,
    resetIso: numbers.resetIso,
  };
}
export function liveNote(live: NonNullable<RosterAccount["live"]>): { short: string; long: string } {
  const age = live.age_minutes;
  const fresh = freshnessLabel(age);
  if (live.rate_limit_reached) {
    return {
      short: translate("limit exhausted · {0}", `limit wyczerpany · ${fresh}`, [fresh]),
      long: translate(
        "The account reports rate_limit_reached: the window is exhausted. Read directly from the account, {0}.",
        `Konto zgłasza rate_limit_reached: okno wyczerpane. Odczyt prosto z konta, ${fresh}.`, [fresh],
      ),
    };
  }
  return {
    short: fresh,
    long: translate(
      "Percentage read directly from the account (app-server, without token cost), {0}. It is not from transcripts, so it is current even for an idle account.",
      `Procent odczytany prosto z konta (app-server, bez kosztu tokenów), ${fresh} — nie z transkryptów, więc jest aktualny także dla konta, które nic nie robi.`, [fresh],
    ),
  };
}
