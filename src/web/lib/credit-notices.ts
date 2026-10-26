import type { CreditNoticeView } from "../../shared/credit-notices";
import { api } from "./api";
import { dayMonth, dayTime } from "./format";
import { getLocale, translate as t } from "./i18n";
import { useAsync } from "./useAsync";

export type NoticeTone = "warn" | "ok" | "info";
/** `detail` is the whole line; `facts` and `when` are its parts without the account, for layouts that place them apart. */
export interface NoticeLine { tone: NoticeTone; title: string; detail: string; facts: string; when: string | null }

const DAY = 86_400_000;
const WARN_KINDS = new Set(["expiring", "expired_unused"]);

/** Open credit notices (`/api/credit-notices`), refreshed with the other live data; null until first read. */
export function useCreditNotices(): { notices: CreditNoticeView[] | null; reload: () => void } {
  const state = useAsync(async () => api.creditNotices(), [], true);
  return { notices: state.data?.notices ?? null, reload: state.reload };
}

export const noticeTone = (notice: Pick<CreditNoticeView, "kind">): NoticeTone =>
  WARN_KINDS.has(notice.kind) ? "warn" : notice.kind === "received" || notice.kind === "topped_up" ? "ok" : "info";

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown) => typeof value === "string" && value !== "" ? value : null;

/** "$250", "$12,50": whole dollars without cents. */
function money(value: number | null): string {
  if (value == null) return "—";
  const cents = Math.round(value * 100) / 100;
  const digits = Number.isInteger(cents) ? 0 : 2;
  return "$" + cents.toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/ /g, " ");
}
/** "60 749,96 kredytów" from the vendor's exact text when there is one. */
function credits(value: number | null, text: string | null = null): string {
  const amount = text != null ? Number(text) : value;
  if (amount == null || !Number.isFinite(amount)) return "—";
  return `${amount.toLocaleString(getLocale(), { maximumFractionDigits: 2 }).replace(/ /g, " ")} ${t("credits", "kredytów")}`;
}
const resets = (count: number | null) => count === 1 || count == null ? t("1 reset", "1 reset")
  : `${count} ${t("resets", [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? "resety" : "resetów")}`;
function amountOf(notice: CreditNoticeView): string {
  if (notice.unit === "usd") return money(notice.amount);
  if (notice.unit === "credits") return credits(notice.amount, notice.amount_text);
  return resets(notice.amount);
}
/** The vendor's English reset title in the reader's language. */
function resetTitle(notice: CreditNoticeView): string {
  const title = str(notice.detail.title);
  if (title == null) return t("limit reset", "reset limitów");
  return title.toLowerCase() === "full reset" ? t("full limit reset", "pełny reset limitów") : title;
}
/** "in 12 days" / "za 12 dni"; under a day in hours. */
export function timeLeft(iso: string | null, now: number): string {
  const left = iso == null ? NaN : Date.parse(iso) - now;
  if (!Number.isFinite(left)) return "—";
  if (left < DAY) { const hours = Math.max(1, Math.round(left / 3_600_000)); return t("in {0} h", `za ${hours} h`, [hours]); }
  const days = Math.round(left / DAY);
  return t(days === 1 ? "in {0} day" : "in {0} days", `za ${days} ${days === 1 ? "dzień" : "dni"}`, [days]);
}

/** One notice as a line of the status bar's details: bold title in its tone, then the facts. */
export function creditNoticeLine(notice: CreditNoticeView, now: number): NoticeLine {
  const tone = noticeTone(notice), d = notice.detail, who = notice.label;
  const reset = notice.unit === "resets";
  const line = (title: string, facts: string, when: string | null = null): NoticeLine =>
    ({ tone, title, facts, when, detail: [who, facts, when].filter(part => part != null).join(" · ") });
  switch (notice.kind) {
    case "expiring": {
      if (reset) return line(t("Reset expires", "Reset wygasa"), `${resetTitle(notice)}, ${t("unused", "niewykorzystany")}`,
        `${t("expires", "wygasa")} ${dayTime(notice.expires_at)} (${timeLeft(notice.expires_at, now)})`);
      const pace = num(d.pace_per_day);
      return line(t("Will expire unused", "Wygaśnie niewykorzystany"), [`grant ${money(num(d.granted))}`,
        `${t("left", "zostało")} ${money(num(d.remaining))}`,
        pace == null ? t("pace not known yet", "tempo jeszcze nieznane") : `${t("use", "zużycie")} ${money(pace)}/${t("day", "dzień")}`,
        `${t("about", "ok.")} ${money(notice.amount)} ${t("lost on", "przepadnie")} ${dayMonth(notice.expires_at)}`].join(" · "));
    }
    case "expired_unused":
      if (reset) return line(t("Reset expired unused", "Reset wygasł niewykorzystany"), resetTitle(notice), dayTime(notice.expires_at));
      return line(t("Expired unused", "Wygasł niewykorzystany"), [`grant ${money(num(d.granted))}`,
        `${t("lost", "przepadło")} ${d.upper_bound === true ? t("up to ", "do ") : ""}${money(notice.amount)}`].join(" · "), dayMonth(notice.expires_at));
    case "received": {
      if (reset) return line(t("New reset", "Nowy reset"), `${resetTitle(notice)}, ${t("valid until", "ważny do")} ${dayMonth(notice.expires_at)}`,
        `${t("received", "otrzymany")} ${dayTime(str(d.granted_at) ?? notice.observed_at)}`);
      const what = notice.unit === "credits" ? credits(notice.amount, notice.amount_text)
        : notice.pool.startsWith("claude:spend") ? `${t("extra usage, limit", "dodatkowe użycie, limit")} ${money(notice.amount)}`
        : `grant ${money(notice.amount)}`;
      const until = notice.expires_at ? `, ${t("valid until", "ważny do")} ${dayMonth(notice.expires_at)}` : "";
      return line(t("New package", "Nowy pakiet"), `${what}${until}`, `${t("received", "otrzymany")} ${dayMonth(notice.observed_at)}`);
    }
    case "topped_up":
      return line(t("Top-up", "Doładowanie"), `+${amountOf(notice)}`, dayMonth(notice.observed_at));
    case "spent": {
      const balance = notice.unit === "credits";
      const left = balance ? credits(num(d.remaining), str(d.remaining_text)) : money(num(d.remaining));
      return line(balance ? t("Credits spent", "Zużyto kredyty") : t("Package used", "Zużyto z pakietu"),
        `−${amountOf(notice)} ${t("since", "od")} ${dayMonth(str(d.since) ?? notice.observed_at)} · ${balance ? t("balance", "saldo") : t("left", "zostało")} ${left}`);
    }
    case "used":
      return line(t("Reset used", "Reset wykorzystany"), resetTitle(notice), dayTime(notice.observed_at));
  }
}

/**
 * The status line's warning: the soonest expiring package, else one that expired unused. Null without
 * warnings; arrivals never take the line (see `creditNoticeSuffix`).
 */
export function creditNoticeAlert(notices: readonly CreditNoticeView[] | null | undefined, now: number): { title: string; detail: string } | null {
  const warnings = (notices ?? []).filter(notice => WARN_KINDS.has(notice.kind));
  if (!warnings.length) return null;
  const expiring = warnings.filter(notice => notice.kind === "expiring")
    .sort((a, b) => (a.expires_at ?? "").localeCompare(b.expires_at ?? ""));
  const first = expiring[0] ?? warnings[0]!;
  const more = warnings.length > 1 ? ` · +${warnings.length - 1} ${t("more", "więcej")}` : "";
  if (first.kind === "expired_unused") {
    const line = creditNoticeLine(first, now);
    return { title: first.unit === "resets" ? t("A limit reset expired unused", "Reset limitów wygasł niewykorzystany")
      : t("A package expired unused", "Pakiet wygasł niewykorzystany"), detail: line.detail + more };
  }
  const left = timeLeft(first.expires_at, now);
  if (first.unit === "resets") return { title: t("A limit reset will expire unused", "Reset limitów wygaśnie niewykorzystany"),
    detail: `${first.label}: ${t("expires", "wygasa")} ${dayTime(first.expires_at)} (${left})${more}` };
  const remaining = num(first.detail.remaining);
  const detail = num(first.detail.pace_per_day) == null
    ? `${first.label}: ${money(remaining)} ${t("left, expires", "zostało, wygasa")} ${dayMonth(first.expires_at)} (${left})`
    : `${first.label}: ${t("at the current pace about", "przy obecnym tempie ok.")} ${money(first.amount)} ${t("of", "z")} ${money(remaining)} `
      + `${t("will be lost on", "przepadnie")} ${dayMonth(first.expires_at)} (${left})`;
  return { title: t("A package will expire unused", "Pakiet wygaśnie niewykorzystany"), detail: detail + more };
}

/** "nowe pakiety: 2 (Claude Max $250, Codex Pro 1 reset)" after "Data up to date"; null without arrivals. */
export function creditNoticeSuffix(notices: readonly CreditNoticeView[] | null | undefined): string | null {
  const arrivals = (notices ?? []).filter(notice => notice.kind === "received" || notice.kind === "topped_up");
  if (!arrivals.length) return null;
  const shown = arrivals.slice(0, 2).map(notice => `${notice.label} ${notice.kind === "topped_up" ? "+" : ""}${amountOf(notice)}`);
  const list = shown.join(", ") + (arrivals.length > shown.length ? ", …" : "");
  return arrivals.length === 1 ? `${t("new package", "nowy pakiet")}: ${list}` : `${t("new packages", "nowe pakiety")}: ${arrivals.length} (${list})`;
}
