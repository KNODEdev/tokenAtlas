import { useEffect, useState } from "react";
import { api, type GrokAnchorResponse } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { dayTime, duration } from "../lib/format";
import { getLocale, useI18n } from "../lib/i18n";
import { Card, CardTitle, GhostButton, Pill } from "./ui";
function localizedNumber(value: number, fractionDigits?: number): string {
  const options = fractionDigits == null
    ? undefined
    : { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
  return value
    .toLocaleString(getLocale(), options)
    .replace(/\u00a0/g, " ");
}
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function GrokAnchorPanel() {
  const { t } = useI18n();
  const state = useAsync(() => api.grokAnchor(), []);
  const [data, setData] = useState<GrokAnchorResponse | null>(null);
  const [ts, setTs] = useState("");
  const [exact, setExact] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const current = data ?? state.data ?? null;
  useEffect(() => {
    if (!current?.anchor) return;
    setTs(toLocalInput(current.anchor.ts));
    setExact(current.anchor.precision !== "day");
  }, [current?.anchor?.ts, current?.anchor?.precision]);
  if (state.error && !current) {
    return (
      <Card>
        <CardTitle title={t("Grok week reset", "Reset tygodnia groka")} sub={t("could not load /api/grok-anchor", "nie udało się wczytać /api/grok-anchor")} />
        <div style={{ fontSize: "var(--fs-4)", color: "var(--warn)" }}>{state.error}</div>
      </Card>
    );
  }
  if (!current) {
    return (
      <Card>
        <CardTitle title={t("Grok week reset", "Reset tygodnia groka")} sub={t("loading declaration…", "wczytuję deklarację…")} />
      </Card>
    );
  }
  const win = current.limit;
  const anchor = current.anchor;
  const save = async (clear: boolean) => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const iso = fromLocalInput(ts);
      if (!clear && !iso) {
        setErr(t("Enter the reset date and time.", "Podaj datę i godzinę resetu."));
        return;
      }
      const res = await api.grokAnchorSave(
        clear
          ? { clear: true }
          : {
              ts: iso,
              precision: exact ? "exact" : "day",
              source: "wpisane ręcznie w panelu Deklaracji",
            },
      );
      setData(res);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardTitle
        title={t("Grok week reset", "Reset tygodnia groka")}
        sub={`${t("Window", "Okno")} ${localizedNumber(current.window_hours)} h · ${current.file}`}
        help={t("xAI does not publish a counter; enter this boundary manually.", "xAI nie publikuje licznika; tę granicę wpisuje się ręcznie.")}
        right={
          win?.anchored ? (
            <Pill tone="ok">{t("anchored", "zakotwiczone")}</Pill>
          ) : (
            <Pill tone="warn">{t("rolling window", "okno kroczące")}</Pill>
          )
        }
      />
      <div style={{ display: "flex", gap: 18, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginBottom: 5 }}>
            {t("Reset visible on account (local time)", "Reset widoczny na koncie (czas lokalny)")}
          </div>
          <input
            type="datetime-local"
            value={ts}
            onChange={(e) => setTs(e.target.value)}
            aria-label={t("Grok week reset date and time", "Data i godzina resetu tygodnia groka")}
            className="ui-date-input"
            style={{ colorScheme: "dark light" }}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fs-4)", paddingBottom: 6 }}>
          <input
            type="checkbox"
            checked={exact}
            onChange={(e) => setExact(e.target.checked)}
            style={{ accentColor: "var(--accent)" }}
          />
          {t("I know the time", "znam godzinę")}
        </label>
        <GhostButton onClick={() => save(false)} disabled={busy}>
          {busy ? t("saving…", "zapisuję…") : t("Save anchor", "Zapisz kotwicę")}
        </GhostButton>
        {anchor && (
          <GhostButton onClick={() => save(true)} disabled={busy} title={t("Return to the rolling window", "Wróć do okna kroczącego")}>
            {t("Remove anchor", "Usuń kotwicę")}
          </GhostButton>
        )}
        {saved && <span style={{ fontSize: "var(--fs-3)", color: "var(--ok)" }}>{t("saved", "zapisane")}</span>}
      </div>
      {err && <div style={{ marginTop: 10, fontSize: "var(--fs-4)", color: "var(--warn)" }}>{err}</div>}
      {win && (
        <div style={{ marginTop: 12, fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.6 }}>
          {win.anchored ? (
            <>
              {t("Current window", "Bieżące okno")} <strong>{dayTime(win.window_start)}</strong> → <strong>{dayTime(win.window_end)}</strong>
              {win.reset_in_hours != null && <> · {t("reset in", "reset za")} {duration(win.reset_in_hours)}</>}
              <br />
              {t("CLI usage in this window:", "Zużycie CLI w tym oknie:")} <strong>${localizedNumber(win.spend.usd, 2)}</strong> {t("in", "w")} {localizedNumber(win.spend.turns)}{" "}
              {win.spend.turns === 1 ? t("turn", "turze") : t("turns", "turach")}
              {win.percent_est != null && <> · {localizedNumber(win.percent_est, 2)}% {t("of the scale", "skali")}</>}
            </>
          ) : (
            <>
              {t(
                "Without an anchor the window is rolling: seven days back from now. The percentage falls as old traffic leaves the window - this is sample aging, not a reset - and there is no way to say how much of the week remains.",
                "Bez kotwicy okno jest kroczące: siedem dni wstecz od teraz. Procent opada, gdy stary ruch wypada z okna — to starzenie się próbki, nie reset — i nie da się powiedzieć, ile zostało do końca tygodnia.",
              )}
            </>
          )}
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--faint)", lineHeight: 1.55, maxWidth: 880 }}>
        {t("Enter the reset you see on the account - including a ", "Wpisz reset, który widzisz na koncie — także ")}<strong>{t("future", "przyszły")}</strong>
        {t(". The window is measured from the anchor every ", ". Okno odmierza się od kotwicy co")} {localizedNumber(current.window_hours)}{t(" h in both directions, so ", " h w obie strony, więc ")}
        {t(
          "“next reset” works just as well as the last one. Uncheck “I know the time” when you only know the day (for example, from CLI refusal logs) - then the window boundary may shift by several hours and the card can say so instead of pretending to be precise.",
          "„następny reset” działa tak samo dobrze jak ostatni. Odznacz „znam godzinę”, gdy znasz tylko dzień (np. z odmów w logu CLI) — wtedy granica okna może być przesunięta o kilkanaście godzin i karta ma prawo to powiedzieć, zamiast udawać precyzję.",
        )}
        {anchor?.last_refusal_ts && anchor.first_success_ts && (
          <>
            {" "}
            {t("The current anchor is bracketed by the last refusal", "Obecna kotwica jest zaciśnięta między ostatnią odmową")} {" "}<span className="mono">{anchor.last_refusal_ts}</span>{" "}
            {t("and the first successful turn", "a pierwszą udaną turą")} {" "}<span className="mono">{anchor.first_success_ts}</span>.
          </>
        )}
      </div>
    </Card>
  );
}
