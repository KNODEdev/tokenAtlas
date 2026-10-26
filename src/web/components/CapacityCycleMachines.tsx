import { ChartExport } from "./ChartExport";
import { useState } from "react";
import type { CapacityCycleSource } from "../../shared/capacity-cycle";
import { compact, full } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { usageWithContext } from "../lib/capacity-context";
import { CAPACITY_MEASURE_COLOR } from "../lib/codex-capacity";
import { TableRow, CardTitle, Dropdown, HelpBlock, HelpDot, Table, Td, Th } from "./ui";
import "./CapacityCycleModels.css";

type Metric = "api_standard" | "credits_low" | "tokens";
export interface CycleMachine { machine: string | null; usage: Pick<CapacityCycleSource, "events" | "tokens" | "api_standard" | "credits_low" | "unpriced_events" | "priced_tokens">; sources: CapacityCycleSource[] }

/** A machine's or source's amount; null when none of its traffic is priced in a money measure. */
function value(row: CycleMachine["usage"], metric: Metric): number | null {
  return metric !== "tokens" && row.events <= row.unpriced_events ? null : row[metric];
}

/** The cycle's sources grouped by computer, largest token traffic first; unknown computers last. */
export function cycleMachines(sources: readonly CapacityCycleSource[]): CycleMachine[] {
  const machines = new Map<string | null, CycleMachine>();
  for (const source of sources) {
    const row = machines.get(source.machine) ?? { machine: source.machine, sources: [],
      usage: { events: 0, tokens: 0, api_standard: 0, credits_low: 0, unpriced_events: 0, priced_tokens: 0 } };
    for (const key of ["events", "tokens", "api_standard", "credits_low", "unpriced_events", "priced_tokens"] as const) row.usage[key] += source[key];
    row.sources.push(source);
    machines.set(source.machine, row);
  }
  return [...machines.values()].sort((a, b) => Number(a.machine === null) - Number(b.machine === null) || b.usage.tokens - a.usage.tokens);
}

/** The shares of the machines in one measure: priced amounts for money, tokens otherwise. */
export function machineShares(machines: readonly CycleMachine[], metric: Metric): Map<string | null, number | null> {
  const total = machines.reduce((sum, m) => sum + (value(m.usage, metric) ?? 0), 0);
  return new Map(machines.map(m => {
    const n = value(m.usage, metric);
    return [m.machine, n === null || total <= 0 ? null : n / total];
  }));
}

/** The profile part of an archive folder: what follows the computer's name (`sample_a-codex-mr`), or null for its main folder. */
export function sourceProfile(source: Pick<CapacityCycleSource, "name" | "machine">): string | null {
  const folder = source.name.split(/[\\/]/).filter(Boolean).at(-1) ?? source.name;
  if (source.machine === null) return folder;
  const rest = folder.slice(source.machine.length + 1);
  return folder.length > source.machine.length && rest ? rest : null;
}

export function CapacityCycleMachines({ sources, creditsAvailable, contextImpact = false }: { sources: CapacityCycleSource[]; creditsAvailable: boolean; contextImpact?: boolean }) {
  const { t, locale } = useI18n();
  const [metric, setMetric] = useState<Metric>("api_standard");
  const activeMetric = !creditsAvailable && metric === "credits_low" ? "tokens" : metric;
  const machines = cycleMachines(sources.map(row => contextImpact ? usageWithContext(row, true) : row));
  const shares = machineShares(machines, activeMetric);
  const maximum = Math.max(0, ...machines.map(m => value(m.usage, activeMetric) ?? 0));
  const money = (amount: number) => amount.toLocaleString(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: amount > 0 && amount < .01 ? 4 : 2 });
  const amount = (row: CycleMachine["usage"], key: Metric) => {
    const n = value(row, key);
    if (n === null) return t("No valuation", "Brak wyceny");
    return (key !== "tokens" && row.unpriced_events > 0 ? "≥ " : "") + (key === "api_standard" ? money(n) : key === "tokens" ? compact(n) : n.toLocaleString(locale, { maximumFractionDigits: 2 }));
  };
  const share = (n: number | null | undefined) => n == null ? "—" : (100 * n).toLocaleString(locale, { maximumFractionDigits: 1 }) + "%";
  const machineName = (machine: string | null) => machine ?? t("unknown computer", "nieznany komputer");
  const moment = (iso: string) => iso.slice(5, 16).replace("T", " ").replace(/^(\d\d)-(\d\d)/, "$2.$1");
  const metricLabel = activeMetric === "api_standard" ? "API · USD" : activeMetric === "credits_low" ? "Credits" : t("Tokens", "Tokeny");
  return <section className="capacity-cycle-models" aria-label={t("Computers in this cycle", "Komputery w tym cyklu")}>
    <CardTitle title={t("Computers in the whole cycle", "Komputery w całym cyklu")}
      right={<HelpDot label={t("How computers are recognised", "Jak rozpoznajemy komputery")}><HelpBlock>{t("All recorded traffic of this cycle by the computer and profile whose logs recorded it.", "Cały zapisany ruch cyklu według komputera i profilu, którego logi go zapisały.")}</HelpBlock><HelpBlock>{t("Each computer mirrors its profiles into its own archive folders, named after the computer. The computer is read from the folder name.", "Każdy komputer kopiuje swoje profile do własnych folderów archiwum, nazwanych jego nazwą. Komputer odczytujemy z nazwy folderu.")}</HelpBlock>
        <HelpBlock>{t("Traffic that no computer logged (for example in a browser) is not here, although the account meter counts it.", "Ruchu, którego nie zapisał żaden komputer (np. w przeglądarce), tu nie ma, choć licznik konta go uwzględnia.")}</HelpBlock>
      </HelpDot>} />
    {!machines.length ? <p className="capacity-cycle-note">{t("No recorded traffic in this cycle.", "Brak zapisanego ruchu w tym cyklu.")}</p> : <>
      <div className="ui-toolbar">
        <label className="ui-field"><span className="ui-field-label">{t("Compare by", "Porównaj według")}</span>
          <Dropdown className="" ariaLabel={t("Computer chart metric", "Miara wykresu komputerów")} value={activeMetric} onChange={value => setMetric(value as Metric)} options={[
            { value: "api_standard", label: "API · USD" }, ...(creditsAvailable ? [{ value: "credits_low", label: "Credits" }] : []), { value: "tokens", label: t("Tokens", "Tokeny") },
          ]} />
        </label>
        <span className="capacity-cycle-note">{machines.length} {t("computers", "komputery")} · {sources.length} {t("profiles", "profile")}</span>
      </div>
      <ChartExport title={t("Computer shares", "Udziały komputerów") + " · " + metricLabel}><figure className="capacity-model-chart" aria-label={t("Computer shares", "Udziały komputerów") + " · " + metricLabel}>
        {machines.map(m => {
          const n = value(m.usage, activeMetric), width = maximum > 0 && n !== null ? 100 * n / maximum : 0;
          const title = `${machineName(m.machine)} · ${amount(m.usage, activeMetric)} · ${share(shares.get(m.machine))}`;
          return <div key={m.machine ?? ""} className="capacity-model-chart-row">
            <span className="capacity-machine-name" title={m.machine ?? undefined}>{machineName(m.machine)}</span>
            <div className="capacity-model-track" data-unpriced={n === null || undefined} role="img" aria-label={title} title={title}>
              {n === null ? <span className="capacity-model-unpriced">{t("No valuation", "Brak wyceny")}</span>
                : <div className="capacity-model-fill" style={{ width: `${width}%`, background: CAPACITY_MEASURE_COLOR[activeMetric] }} />}
            </div>
            <span className="mono capacity-model-amount">{n === null ? "—" : amount(m.usage, activeMetric)}</span>
            <span className="mono capacity-model-share">{share(shares.get(m.machine))}</span>
          </div>;
        })}
        {activeMetric !== "tokens" && <figcaption className="capacity-cycle-note">{t("Shares refer to the priced portion. A missing price is not zero cost.", "Udziały dotyczą wycenionej części. Brak ceny nie oznacza zerowego kosztu.")}</figcaption>}
      </figure></ChartExport>
      <Table tableId="CapacityCycleMachines:0"><thead><TableRow header><Th columnId="c0">{t("Computer · profile", "Komputer · profil")}</Th><Th columnId="c1" align="right">API · USD</Th>{creditsAvailable && <Th columnId="c2" align="right">Credits</Th>}
        <Th columnId="c3" align="right">{t("Requests", "Żądania")}</Th><Th columnId="c4" align="right">{t("Total tokens", "Suma tokenów")}</Th><Th columnId="c5" align="right">{t("Share", "Udział")}</Th><Th columnId="c6">{t("First → last request (UTC)", "Pierwsze → ostatnie żądanie (UTC)")}</Th></TableRow></thead>
        <tbody>{machines.flatMap(m => {
          const total = machines.reduce((sum, row) => sum + (value(row.usage, activeMetric) ?? 0), 0);
          const sourceShare = (source: CapacityCycleSource) => { const n = value(source, activeMetric); return n === null || total <= 0 ? null : n / total; };
          const first = m.sources.reduce((a, s) => s.first < a ? s.first : a, m.sources[0]!.first), last = m.sources.reduce((a, s) => s.last > a ? s.last : a, m.sources[0]!.last);
          // A computer with one profile names it in its own row; several profiles get rows under it.
          const single = m.sources.length === 1 ? m.sources[0]! : null;
          return [<TableRow key={`m:${m.machine ?? ""}`} className="capacity-machine-row">
            <Td title={single?.name ?? m.machine ?? undefined}>{machineName(m.machine)}{single && m.machine !== null && <span className="capacity-cycle-note"> · {sourceProfile(single) ?? t("main profile", "profil główny")}</span>}</Td>
            <Td mono align="right">{amount(m.usage, "api_standard")}</Td>{creditsAvailable && <Td mono align="right">{amount(m.usage, "credits_low")}</Td>}
            <Td mono align="right">{full(m.usage.events)}</Td><Td mono align="right" title={full(m.usage.tokens)}>{compact(m.usage.tokens)}</Td>
            <Td mono align="right">{share(shares.get(m.machine))}</Td><Td mono>{moment(first)} → {moment(last)}</Td></TableRow>,
          ...(single ? [] : m.sources.map(source => <TableRow key={`s:${source.name}`} className="capacity-source-row">
            <Td title={source.name}>{sourceProfile(source) ?? t("main profile", "profil główny")}</Td>
            <Td mono align="right">{amount(source, "api_standard")}</Td>{creditsAvailable && <Td mono align="right">{amount(source, "credits_low")}</Td>}
            <Td mono align="right">{full(source.events)}</Td><Td mono align="right" title={full(source.tokens)}>{compact(source.tokens)}</Td>
            <Td mono align="right">{share(sourceShare(source))}</Td><Td mono>{moment(source.first)} → {moment(source.last)}</Td></TableRow>))];
        })}</tbody>
      </Table>
      <p className="capacity-cycle-note">{t("Shares use the measure chosen above. Profile rows sit under their computer; hover a profile for its archive folder.", "Udziały liczone są w mierze wybranej wyżej. Profile są pod swoim komputerem; wskaż profil, aby zobaczyć jego folder w archiwum.")}</p>
      {machines.some(m => m.machine === null) && <p className="capacity-cycle-notice">{t("Some folders do not start with the name of a computer that records readings, so their computer is unknown.", "Część folderów nie zaczyna się nazwą komputera, który zapisuje odczyty, więc ich komputer jest nieznany.")}</p>}
    </>}
  </section>;
}
