import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isCorrectable, overrideCauses, type AccountWindowEnd, type AccountWindowEnds, type OverrideCause } from "../../shared/window-end-overrides";
import { api, ApiError, refreshApiData } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { causeLabel, causeTone, durationText } from "../lib/window-end-cause";
import type { RailAccount } from "./AccountPeriodGroups";
import { ErrorState, Field, LoadingCard, Selector, Table, TableRow, Td, Th, toneColor } from "./ui";
import "./WindowEndSettings.css";

type Show = "cycle" | "early" | "all";

/**
 * Settings → Accounts → Windows: the account's main-counter windows, newest first, with how each ended. The kind of an
 * early reset can be corrected; the background step applies it and the cycles holding it follow.
 */
export function WindowEndSettings({ account, cycle }: { account: RailAccount; cycle: { start: string; end: string } | null }) {
  return <WindowEndEditor key={`${account.provider}|${account.account}|${account.aliases.join("|")}|${cycle?.start}|${cycle?.end}`} account={account} cycle={cycle} />;
}

function WindowEndEditor({ account, cycle }: { account: RailAccount; cycle: { start: string; end: string } | null }) {
  const { t, locale } = useI18n();
  const ids = [...new Set([account.account, ...account.aliases].map((id) => id.toLowerCase()))];
  const state = useAsync((signal) => api.windowEndOverrides(account.provider, ids, signal), [account.provider, ids.join("|")]);
  const [saved, setSaved] = useState<AccountWindowEnds | null>(null);
  const [show, setShow] = useState<Show>(cycle ? "cycle" : "early");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = saved ?? state.data;
  const first = useRef<HTMLTableRowElement>(null);
  // A correction is applied by the background step within a turn or two: read again until it is.
  useEffect(() => {
    if (!data?.pending) return;
    const timer = setTimeout(() => { setSaved(null); state.reload(); }, 1500);
    return () => clearTimeout(timer);
  }, [data]);
  useEffect(() => { first.current?.scrollIntoView({ block: "nearest" }); }, [!!data, show]);

  if (!data && state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!data) return <LoadingCard label={t("Loading windows…", "Wczytywanie okien…")} shape="table" />;
  const inCycle = (w: AccountWindowEnd) => !!cycle && w.window_start < cycle.end && w.window_end > cycle.start;
  const lists: Record<Show, AccountWindowEnd[]> = {
    cycle: data.windows.filter(inCycle), early: data.windows.filter((w) => isCorrectable(w.auto)), all: data.windows,
  };
  const rows = lists[show];
  const moment = (value: string) => new Date(value).toLocaleString(locale, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const choices = overrideCauses(account.provider);

  const save = async (w: AccountWindowEnd, value: string) => {
    const key = `${w.account}|${w.counter}|${w.window_start}`;
    if (busy) return;
    setBusy(key); setError(null);
    try {
      const next = await api.saveWindowEndOverride(account.provider, ids, { revision: data.revision, account: w.account, counter: w.counter,
        window_start: w.window_start, cause: value ? value as OverrideCause : null });
      setSaved(next);
      refreshApiData();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      if (failure instanceof ApiError && failure.status === 409) { setSaved(null); state.reload(); }
    } finally { setBusy(null); }
  };

  const label = (value: Show) => value === "cycle" ? `${t("This cycle", "Ten cykl")} · ${lists.cycle.length}`
    : value === "early" ? `${t("Early resets", "Wczesne resety")} · ${lists.early.length}` : `${t("All", "Wszystkie")} · ${lists.all.length}`;
  let firstMarked = false;
  return <div className="window-end-settings" data-window-end-settings={account.account}>
    <div className="ui-toolbar window-end-settings-tools">
      <Field label={t("Show", "Pokaż")}>
        <div className="ui-choice" role="group" aria-label={t("Show", "Pokaż")}>
          {((cycle ? ["cycle", "early", "all"] : ["early", "all"]) as Show[]).map((value) =>
            <button key={value} type="button" aria-pressed={show === value} data-show={value} onClick={() => setShow(value)}>{label(value)}</button>)}
        </div>
      </Field>
      {data.pending && <span role="status" className="window-end-settings-status">{t("Applying…", "Przeliczanie…")}</span>}
    </div>
    {error && <ErrorState message={error} />}
    {!rows.length ? <p className="window-end-settings-empty">{t("No windows", "Brak okien")}</p>
    : <div className="window-end-settings-list"><Table tableId="WindowEndSettings:0">
      <thead><TableRow header>
        <Th columnId="start">{t("Start", "Start")}</Th><Th columnId="length">{t("Length", "Długość")}</Th>
        <Th columnId="detected">{t("Detected", "Rozpoznano")}</Th><Th columnId="cause">{t("End cause", "Przyczyna końca")}</Th>
      </TableRow></thead>
      <tbody>{rows.map((w) => {
        const marked = show !== "cycle" && inCycle(w);
        const ref = marked && !firstMarked ? (firstMarked = true, first) : undefined;
        const key = `${w.account}|${w.window_start}`;
        return <TableRow key={key} ref={ref} className={marked ? "is-selected" : undefined} data-window-end={w.window_start} data-cause={w.cause}>
          <Td mono title={`${moment(w.window_start)} → ${moment(w.window_end)}`}>{moment(w.window_start)}</Td>
          <Td mono>{w.auto === "open" ? t("ongoing", "trwa") : durationText(w.window_start, w.window_end, t)}</Td>
          <Td><span className="window-end-cause" style={{ "--cause-ink": toneColor(causeTone(w.auto)) } as CSSProperties}>{causeLabel(w.auto, t)}</span></Td>
          <Td>{isCorrectable(w.auto)
            ? <Selector ariaLabel={t("End cause", "Przyczyna końca")} value={w.override ?? ""} onChange={(value) => void save(w, value)}
                options={[{ value: "", label: t("As detected", "Jak rozpoznano"), disabled: busy !== null },
                  ...choices.filter((cause) => cause !== w.auto).map((cause) => ({ value: cause, label: causeLabel(cause, t), disabled: busy !== null }))]} />
            : <span className="window-end-settings-fixed" title={t("Only an early reset's kind can be corrected", "Poprawić można tylko rodzaj wczesnego resetu")}>—</span>}</Td>
        </TableRow>;
      })}</tbody>
    </Table></div>}
  </div>;
}
