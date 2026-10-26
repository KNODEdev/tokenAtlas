import { Fragment, useMemo, useState, type ReactNode } from "react";
import type {
  CadenceSegmentRow,
  CycleSaveRequest,
  CycleSaveResponse,
  CycleSettingRow,
  CyclesResponse,
} from "../lib/api";
import { dayTime, duration } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { CyclesPanel } from "./CyclesPanel";
import { TableRow, Card, CardTitle, EmptyState, GhostButton, Pill, Table, Td, Th, type Tone } from "./ui";
export interface RhythmProviderGroup {
  id: string;
  label: string;
  aliases: string[];
}
export interface WindowRhythmsPanelProps {
  data: CyclesResponse;
  asOf: string;
  provider: string;
  providerGroups: RhythmProviderGroup[];
  onSave: (request: CycleSaveRequest) => Promise<CycleSaveResponse>;
  defaultExpandedKeys?: string[];
  initialSaveErrors?: Record<string, string>;
  providerTools?: Record<string, ReactNode>;
  rowTools?: Record<string, ReactNode>;
  /** Inside one account's fold: the provider group heading would only repeat the account, so it is left out. */
  bare?: boolean;
}
const SOURCE_TONE: Record<string, Tone> = {
  declared: "accent",
  probe: "ok",
  default: "neutral",
  none: "warn",
};
export function rhythmRowKey(row: Pick<CycleSettingRow, "subscription" | "kind">): string {
  return `${row.subscription}/${row.kind}`;
}
function sortedSegments(row: CycleSettingRow): CadenceSegmentRow[] {
  return [...row.segments].sort((a, b) => {
    if (a.from == null && b.from == null) return 0;
    if (a.from == null) return -1;
    if (b.from == null) return 1;
    return a.from.localeCompare(b.from);
  });
}
export function cadenceSegmentForDay(row: CycleSettingRow, asOf: string): CadenceSegmentRow | null {
  let selected: CadenceSegmentRow | null = null;
  for (const segment of sortedSegments(row)) {
    if (segment.from == null || segment.from <= asOf) selected = segment;
    else break;
  }
  return selected;
}
function providerGroupFor(vendor: string, groups: RhythmProviderGroup[]): RhythmProviderGroup {
  const wanted = vendor.trim().toLowerCase();
  return (
    groups.find((group) =>
      [group.id, ...(group.aliases ?? [])].some((alias) => alias.trim().toLowerCase() === wanted)
    ) ?? { id: vendor || "unknown", label: vendor || translate("Unknown provider", "Nieznany dostawca"), aliases: vendor ? [vendor] : [] }
  );
}
interface GroupedRows {
  group: RhythmProviderGroup;
  subscriptions: Array<{ id: string; rows: CycleSettingRow[] }>;
}
export function groupRhythmRows(
  rows: CycleSettingRow[],
  groups: RhythmProviderGroup[],
  provider: string
): GroupedRows[] {
  const byGroup = new Map<string, { group: RhythmProviderGroup; rows: CycleSettingRow[] }>();
  for (const row of rows) {
    const group = providerGroupFor(row.vendor, groups);
    if (provider !== "all" && group.id !== provider) continue;
    const bucket = byGroup.get(group.id) ?? { group, rows: [] };
    bucket.rows.push(row);
    byGroup.set(group.id, bucket);
  }
  const order = new Map(groups.map((group, index) => [group.id, index]));
  return [...byGroup.values()]
    .sort((a, b) => {
      const rank = (order.get(a.group.id) ?? 1_000) - (order.get(b.group.id) ?? 1_000);
      return rank || a.group.label.localeCompare(b.group.label);
    })
    .map(({ group, rows: groupRows }) => {
      const bySubscription = new Map<string, CycleSettingRow[]>();
      for (const row of groupRows) {
        const bucket = bySubscription.get(row.subscription) ?? [];
        bucket.push(row);
        bySubscription.set(row.subscription, bucket);
      }
      return {
        group,
        subscriptions: [...bySubscription.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, subscriptionRows]) => ({
            id,
            rows: subscriptionRows.sort((a, b) => a.kind.localeCompare(b.kind)),
          })),
      };
    });
}
function sourceLabel(source: string): string {
  if (source === "declared") return translate("declared", "deklaracja");
  if (source === "probe") return translate("observed (fallback)", "obserwacja (fallback)");
  if (source === "default") return translate("default (fallback)", "domyślna (fallback)");
  if (source === "none") return translate("none", "brak");
  return source;
}
function sourceTone(source: string): Tone {
  return SOURCE_TONE[source] ?? "neutral";
}
function originLabel(segment: CadenceSegmentRow): string {
  if (segment.from) return segment.from;
  return segment.declaration ? translate("origin (legacy)", "origin (legacy)") : translate("fallback before declaration", "fallback przed deklaracją");
}
function absenceReason(row: CycleSettingRow, asOf: string): string {
  if (row.segments.length === 0) return translate("no declared or observed cadence", "brak zadeklarowanego ani zaobserwowanego rytmu");
  const first = sortedSegments(row)[0];
  return first?.from
    ? `${translate("no interval applies on", "brak odcinka obowiązującego")} ${asOf}; ${translate("the first interval starts", "pierwszy odcinek zaczyna się")} ${first.from}`
    : translate("the server did not provide an interval for the selected day", "serwer nie wskazał odcinka obowiązującego na wybrany dzień");
}
function SummaryValue({ children, reason }: { children: ReactNode; reason?: string }) {
  useI18n();
  return (
    <div className="mono" style={{ fontSize: "var(--fs-3)", color: children === "—" ? "var(--faint)" : "var(--text)" }}>
      {children}
      {reason && <div style={{ marginTop: "var(--s-1)", fontSize: "var(--fs-2)", color: "var(--muted)", whiteSpace: "normal" }}>{reason}</div>}
    </div>
  );
}
function HistoryTable({ row, asOf }: { row: CycleSettingRow; asOf: string }) {
  const { t } = useI18n();
  const active = cadenceSegmentForDay(row, asOf);
  const segments = sortedSegments(row);
  if (segments.length === 0) {
    return <EmptyState title="—" detail={absenceReason(row, asOf)} />;
  }
  return (
    <Table tableId="WindowRhythmsPanel:0">
      <thead>
        <TableRow header>
          <Th columnId="c0">{t("from / interval boundary", "od / granica odcinka")}</Th>
          <Th columnId="c1" align="right">{t("frequency", "częstotliwość")}</Th>
          <Th columnId="c2">{t("reset anchor", "kotwica resetu")}</Th>
          <Th columnId="c3" align="right">{t("history", "historia")}</Th>
          <Th columnId="c4">{t("source / evidence", "źródło / dowód")}</Th>
          <Th columnId="c5">{t("note", "notatka")}</Th>
        </TableRow>
      </thead>
      <tbody>
        {segments.map((segment, index) => {
          const selected = segment === active;
          return (
            <TableRow
              key={`${segment.from ?? "origin"}:${index}`}
              data-history-segment={`${rhythmRowKey(row)}:${index}`}
              data-segment-from={segment.from ?? "origin"}
              data-active={selected ? "true" : "false"}
              data-provenance={segment.source}
              data-declaration={segment.declaration ? "true" : "false"}
              style={{ background: selected ? "var(--accent-soft)" : "transparent" }}
            >
              <Td mono>
                <div style={{ color: selected ? "var(--accent)" : "var(--text)", fontWeight: selected ? "var(--fw-semibold)" : "var(--fw-regular)" }}>
                  {originLabel(segment)}
                </div>
                {segment.from == null && (
                  <div style={{ marginTop: "var(--s-1)", color: "var(--muted)", fontSize: "var(--fs-2)" }}>
                    {segment.declaration ? t("from the beginning of known history", "od początku znanej historii") : t("when no declaration covers it", "gdy brak pokrywającej deklaracji")}
                  </div>
                )}
              </Td>
              <Td align="right" mono title={`${segment.period_hours} h`}>
                {t("every", "co")} {segment.period_hours} h · {duration(segment.period_hours)}
              </Td>
              <Td mono>
                {segment.anchor_ts ? (
                  <div>
                    {dayTime(segment.anchor_ts)}
                    <div style={{ marginTop: "var(--s-1)", color: "var(--muted)", fontSize: "var(--fs-2)" }}>
                      {sourceLabel(segment.anchor_source)}
                    </div>
                  </div>
                ) : (
                  <SummaryValue reason={t("reset anchor unavailable", "brak kotwicy resetu")}>—</SummaryValue>
                )}
              </Td>
              <Td align="right" mono>
                {segment.history_windows == null ? "—" : segment.history_windows}
              </Td>
              <Td>
                <Pill tone={sourceTone(segment.source)}>{sourceLabel(segment.source)}</Pill>
                {!segment.declaration && (
                  <div className="mono" style={{ marginTop: "var(--s-1)", color: "var(--muted)", fontSize: "var(--fs-2)" }}>
                    {t("read-only", "tylko do odczytu")}
                  </div>
                )}
              </Td>
              <Td style={{ color: "var(--muted)", whiteSpace: "normal", minWidth: 150 }}>{segment.note ?? "—"}</Td>
            </TableRow>
          );
        })}
      </tbody>
    </Table>
  );
}
export function WindowRhythmsPanel({
  data,
  asOf,
  provider,
  providerGroups,
  onSave,
  defaultExpandedKeys = [],
  initialSaveErrors = {},
  providerTools = {},
  rowTools = {},
  bare = false,
}: WindowRhythmsPanelProps) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(() => new Set(defaultExpandedKeys));
  const grouped = useMemo(
    () => groupRhythmRows(data.rows, providerGroups, provider),
    [data.rows, providerGroups, provider, language]
  );
  const visibleGroups = useMemo(() => {
    const next = [...grouped];
    for (const group of providerGroups) {
      if (!providerTools[group.id]) continue;
      if (provider !== "all" && provider !== group.id) continue;
      if (!next.some((entry) => entry.group.id === group.id)) next.push({ group, subscriptions: [] });
    }
    return next;
  }, [grouped, providerGroups, provider, providerTools]);
  const toggle = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  if (visibleGroups.length === 0) {
    return (
      <EmptyState
        title={t("No window cadences", "Brak rytmów okien")}
        detail={t("The API provider returned neither a declaration nor an observed fallback for the selected group.", "Dla wybranej grupy dostawcy API nie zwróciło deklaracji ani obserwowanego fallbacku.")}
      />
    );
  }
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--s-8)" }}
      data-window-rhythms="1"
      data-provider-filter={provider}
      data-as-of={asOf}
    >
      <Card pad="var(--s-5) var(--s-7)" style={{ background: "var(--sunk)" }}>
        <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.55 }}>
          <strong style={{ color: "var(--text)" }}>{t("The from boundary changes cadence only from that date.", "Granica „od” zmienia rytm tylko od tej daty.")}</strong>{" "}
          {t("Older windows keep the earlier cadence. A declared anchor is not labeled as an observation and does not extend backward before its own", "Starsze okna zachowują wcześniejszy rytm. Zadeklarowana kotwica nie jest podpisywana jako obserwacja i nie rozciąga się wstecz przed własne")} <span className="mono">from</span>.
        </div>
      </Card>
      {visibleGroups.map(({ group, subscriptions }) => (
        <Card key={group.id} pad="0" style={{ overflow: "hidden" }}>
          {!bare && (
            <div style={{ padding: "var(--s-8) var(--s-9)", borderBottom: "var(--rule)" }}>
              <CardTitle
                title={group.label}
                sub={`${subscriptions.length} ${t("subscriptions", "Subskrypcji")} · ${t("aliases", "aliasy")}: ${group.aliases.join(" · ") || group.id}`}
              />
            </div>
          )}
          {subscriptions.map((subscription) => (
            <section key={subscription.id} data-provider-group={group.id} data-subscription={subscription.id}>
              <div
                style={{
                  padding: "var(--s-4) var(--s-9)",
                  background: "var(--band)",
                  borderBottom: "1px solid var(--line)",
                  fontSize: "var(--fs-5)",
                  fontWeight: "var(--fw-semibold)",
                }}
              >
                <span className="mono">{subscription.id}</span>
                <span style={{ marginLeft: "var(--s-4)", color: "var(--muted)", fontWeight: "var(--fw-regular)" }}>{t("Subscription", "Subskrypcja")}</span>
              </div>
              <Table tableId="WindowRhythmsPanel:1">
                <thead>
                  <TableRow header>
                    <Th columnId="c0">{t("window kind", "rodzaj okna")}</Th>
                    <Th columnId="c1" align="right">{t("frequency", "częstotliwość")}</Th>
                    <Th columnId="c2">{t("anchor / reset", "kotwica / reset")}</Th>
                    <Th columnId="c3">{t("effective from", "obowiązuje od")}</Th>
                    <Th columnId="c4">{t("provenance", "proweniencja")}</Th>
                    <Th columnId="c5" align="right">{t("history", "historia")}</Th>
                  </TableRow>
                </thead>
                <tbody>
                  {subscription.rows.map((row) => {
                    const key = rhythmRowKey(row);
                    const active = cadenceSegmentForDay(row, asOf);
                    const open = expanded.has(key);
                    const missing = active == null;
                    return (
                      <Fragment key={key}>
                        <TableRow
                          data-rhythm-row={key}
                          data-selected-segment={
                            active?.from ?? (active ? (active.declaration ? "origin" : "observed-fallback") : "none")
                          }
                          data-selected-source={active?.source ?? "none"}
                        >
                          <Td>
                            <div style={{ fontWeight: "var(--fw-semibold)" }}>{row.label}</div>
                            <div className="mono" style={{ marginTop: "var(--s-1)", fontSize: "var(--fs-2)", color: "var(--muted)" }}>
                              {row.kind} · {row.vendor}
                            </div>
                          </Td>
                          <Td align="right" mono>
                            {active ? (
                              <span title={`${active.period_hours} h`}>{t("every", "co")} {active.period_hours} h · {duration(active.period_hours)}</span>
                            ) : (
                              <SummaryValue reason={absenceReason(row, asOf)}>—</SummaryValue>
                            )}
                          </Td>
                          <Td mono>
                            {active?.anchor_ts ? (
                              <div title={active.anchor_ts}>
                                {dayTime(active.anchor_ts)}
                                <div style={{ marginTop: "var(--s-1)", color: "var(--muted)", fontSize: "var(--fs-2)" }}>
                                  {t("anchor", "kotwica")} · {sourceLabel(active.anchor_source)}
                                </div>
                              </div>
                            ) : (
                              <SummaryValue reason={missing ? absenceReason(row, asOf) : t("reset anchor unavailable", "brak kotwicy resetu")}>—</SummaryValue>
                            )}
                          </Td>
                          <Td mono>{active ? originLabel(active) : "—"}</Td>
                          <Td>
                            {active ? (
                              <Pill tone={sourceTone(active.source)}>{sourceLabel(active.source)}</Pill>
                            ) : (
                              <Pill tone="warn">{t("missing", "brak")}</Pill>
                            )}
                          </Td>
                          <Td align="right">
                            <GhostButton onClick={() => toggle(key)} title={t("Full, untrimmed cadence history", "Pełna, nieprzycięta historia rytmu")}>
                              {open ? t("collapse", "zwiń") : `${t("expand", "rozwiń")} (${row.segments.length})`}
                            </GhostButton>
                          </Td>
                        </TableRow>
                        {open && (
                          <TableRow data-rhythm-expanded={key}>
                            <Td colSpan={6} style={{ padding: "var(--s-6)", background: "var(--sunk)", whiteSpace: "normal" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
                                <HistoryTable row={row} asOf={asOf} />
                                <CyclesPanel
                                  row={row}
                                  asOf={asOf}
                                  onSave={onSave}
                                  initialSaveError={initialSaveErrors[key]}
                                />
                                {rowTools[key]}
                              </div>
                            </Td>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            </section>
          ))}
          {providerTools[group.id] && (
            <div style={{ padding: "var(--s-6) var(--s-9)", borderTop: "var(--rule)", background: "var(--sunk)" }}>
              {providerTools[group.id]}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
