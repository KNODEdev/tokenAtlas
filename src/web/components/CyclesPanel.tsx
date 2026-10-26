import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CycleSaveRequest, CycleSaveResponse, CycleSettingRow } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { TableRow, EmptyState, GhostButton, Pill, Table, Td, TextInput, Th } from "./ui";
// The panel sits inside a table cell of a card: a group under a dashed rule with a Plex heading, not a nested card.
function PanelHeading({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="ui-card-title">
      <div className="ui-card-title-content">
        <div style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)", color: "var(--text)" }}>{title}</div>
        {sub && <div className="mono ui-card-subtitle">{sub}</div>}
      </div>
      {right}
    </div>
  );
}
const group = { borderTop: "var(--rule)", paddingTop: "var(--s-6)" } as const;
export interface CadenceDraftSegment {
  id: string;
  from: string;
  period: string;
  anchor: string;
  history: string;
  note: string;
}
export interface CadenceEditorState {
  draft: CadenceDraftSegment[];
  error: string | null;
}
export function createCadenceDraftIdFactory(): () => string {
  let next = 0;
  return () => `draft-${next++}`;
}
export function appendCadenceDraftSegment(
  draft: CadenceDraftSegment[],
  id: string,
  asOf: string,
  seed?: CadenceDraftSegment
): CadenceDraftSegment[] {
  return [
    ...draft,
    {
      id,
      from: asOf,
      period: seed?.period ?? "",
      anchor: seed?.anchor ?? "",
      history: seed?.history ?? "",
      note: "",
    },
  ];
}
export function patchCadenceDraftSegment(
  draft: CadenceDraftSegment[],
  id: string,
  part: Partial<CadenceDraftSegment>
): CadenceDraftSegment[] {
  return draft.map((segment) => (segment.id === id ? { ...segment, ...part } : segment));
}
export function removeCadenceDraftSegment(
  draft: CadenceDraftSegment[],
  id: string
): CadenceDraftSegment[] {
  return draft.filter((segment) => segment.id !== id);
}
export type CadenceSaveResult =
  | { ok: true; canonical: CadenceDraftSegment[] }
  | { ok: false; error: string };
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
export function cadenceDraftFromRow(row: CycleSettingRow): CadenceDraftSegment[] {
  if (!row.declared) return [];
  return row.segments.filter((segment) => segment.declaration).map((segment, index) => ({
    id: `segment-${index}`,
    from: segment.from ?? "",
    period: String(segment.period_hours),
    anchor: toLocalInput(segment.anchor_ts),
    history: segment.history_windows == null ? "" : String(segment.history_windows),
    note: segment.note ?? "",
  }));
}
export function cadenceDraftPayload(
  subscription: string,
  kind: string,
  draft: CadenceDraftSegment[]
): { segments: NonNullable<CycleSaveRequest["segments"]> } | { error: string } {
  const segments: NonNullable<CycleSaveRequest["segments"]> = [];
  for (const [index, segment] of draft.entries()) {
    const from = segment.from.trim();
    if (from && !validDay(from)) {
      return { error: `${subscription}/${kind}: odcinek #${index + 1} ma niepoprawne \`from\`` };
    }
    const period = Number(segment.period);
    if (!Number.isFinite(period)) {
      return { error: `${subscription}/${kind}: odcinek #${index + 1} ma niepoprawny okres` };
    }
    const anchor = fromLocalInput(segment.anchor);
    if (segment.anchor.trim() && anchor == null) {
      return { error: `${subscription}/${kind}: odcinek #${index + 1} ma niepoprawną kotwicę` };
    }
    const history = segment.history.trim() === "" ? null : Number(segment.history);
    if (history != null && !Number.isFinite(history)) {
      return { error: `${subscription}/${kind}: odcinek #${index + 1} ma niepoprawny zasięg historii` };
    }
    segments.push({
      from: from || null,
      period_hours: period,
      anchor_ts: anchor,
      history_windows: history,
      note: segment.note.trim() || null,
    });
  }
  return { segments };
}
export function reduceCadenceSave(state: CadenceEditorState, result: CadenceSaveResult): CadenceEditorState {
  return result.ok
    ? { draft: result.canonical, error: null }
    : { draft: state.draft, error: result.error };
}
function cadenceErrorLabel(error: string, t: (en: string, pl: string) => string): string {
  const match = error.match(/^(.*): odcinek #(\d+) ma (niepoprawne `from`|niepoprawny okres|niepoprawną kotwicę|niepoprawny zasięg historii)$/);
  if (!match) return error;
  const phrase = ({
    "niepoprawne `from`": t("has an invalid `from`", "ma niepoprawne `from`"),
    "niepoprawny okres": t("has an invalid period", "ma niepoprawny okres"),
    "niepoprawną kotwicę": t("has an invalid reset anchor", "ma niepoprawną kotwicę"),
    "niepoprawny zasięg historii": t("has an invalid history range", "ma niepoprawny zasięg historii"),
  } as Record<string, string>)[match[3]!] ?? match[3];
  return `${match[1]}: ${t("segment", "odcinek")} #${match[2]} ${phrase}`;
}
export interface CyclesPanelProps {
  row: CycleSettingRow;
  asOf: string;
  onSave: (request: CycleSaveRequest) => Promise<CycleSaveResponse>;
  onCanonical?: (row: CycleSettingRow) => void;
  initialSaveError?: string | null;
}
export function CyclesPanel({ row, asOf, onSave, onCanonical, initialSaveError = null }: CyclesPanelProps) {
  const { t } = useI18n();
  const [state, setState] = useState<CadenceEditorState>({
    draft: cadenceDraftFromRow(row),
    error: initialSaveError,
  });
  const [busy, setBusy] = useState(false);
  const previousRow = useRef(row);
  const nextDraftId = useRef(createCadenceDraftIdFactory()).current;
  useEffect(() => {
    if (previousRow.current === row) return;
    previousRow.current = row;
    setState({ draft: cadenceDraftFromRow(row), error: null });
  }, [row]);
  const canEdit = row.declaration_editable;
  const patchSegment = (id: string, part: Partial<CadenceDraftSegment>) => {
    setState((prev) => ({
      ...prev,
      draft: patchCadenceDraftSegment(prev.draft, id, part),
    }));
  };
  const addSegment = () => {
    setState((prev) => ({
      ...prev,
      error: null,
      draft: appendCadenceDraftSegment(prev.draft, nextDraftId(), asOf, prev.draft[prev.draft.length - 1]),
    }));
  };
  const save = async () => {
    const payload = cadenceDraftPayload(row.subscription, row.kind, state.draft);
    if ("error" in payload) {
      setState((prev) => ({ ...prev, error: payload.error }));
      return;
    }
    setBusy(true);
    setState((prev) => ({ ...prev, error: null }));
    try {
      const result = await onSave({
        subscription: row.subscription,
        kind: row.kind,
        segments: payload.segments,
      });
      const canonical = result.rows.find(
        (candidate) =>
          candidate.subscription.toLowerCase() === row.subscription.toLowerCase() &&
          candidate.kind.toLowerCase() === row.kind.toLowerCase()
      );
      const canonicalDraft = canonical ? cadenceDraftFromRow(canonical) : [];
      setState((prev) => reduceCadenceSave(prev, { ok: true, canonical: canonicalDraft }));
      if (canonical) onCanonical?.(canonical);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => reduceCadenceSave(prev, { ok: false, error: message }));
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit) {
    return (
      <div style={group}>
        <PanelHeading title={t("Declaration is read-only", "Deklaracja tylko do odczytu")} sub={row.effect} />
      </div>
    );
  }
  return (
    <div
      data-cadence-editor={`${row.subscription}/${row.kind}`}
      data-declaration-editable="true"
    >
      <div style={group}>
        <PanelHeading
          title={t("Full declaration history", "Pełna historia deklaracji")}
          sub={t("Saving atomically replaces the full history for this subscription and window type. Probe evidence remains read-only.", "Zapis zastępuje atomowo całą historię tej Subskrypcji i rodzaju okna. Dowody z probe'a pozostają tylko do odczytu.")}
          right={<Pill tone="accent">{t("declaration", "deklaracja")}</Pill>}
        />
      {state.error && (
        <div
          className="mono"
          data-save-error="1"
          style={{ marginTop: "var(--s-5)", fontSize: "var(--fs-3)", color: "var(--crit)", whiteSpace: "pre-wrap" }}
        >
          {cadenceErrorLabel(state.error, t)}
        </div>
      )}
      <div data-draft-count={state.draft.length} style={{ marginTop: "var(--s-5)" }}>
        {state.draft.length === 0 ? (
          <EmptyState
            title={t("No declared segments", "Brak deklarowanych odcinków")}
            detail={t("The observed cadence is not copied into the declaration. Adding a segment is an intentional change from the selected date.", "Zaobserwowany rytm nie jest kopiowany do deklaracji. Dodanie odcinka jest świadomą zmianą od wybranej daty.")}
          />
        ) : (
          <Table tableId="CyclesPanel:0">
            <thead>
              <TableRow header>
                <Th columnId="c0">{t("from", "od")}</Th>
                <Th columnId="c1" align="right">{t("period [h]", "okres [h]")}</Th>
                <Th columnId="c2">{t("reset anchor", "kotwica resetu")}</Th>
                <Th columnId="c3" align="right">{t("history windows", "okien wstecz")}</Th>
                <Th columnId="c4">{t("note / evidence", "notatka / dowód")}</Th>
                <Th columnId="c5" align="right">{t("action", "akcja")}</Th>
              </TableRow>
            </thead>
            <tbody>
              {state.draft.map((segment) => (
                <TableRow key={segment.id} data-draft-segment={segment.id}>
                  <Td>
                    <TextInput
                      value={segment.from}
                      onChange={(from) => patchSegment(segment.id, { from })}
                      width={102}
                      placeholder="RRRR-MM-DD"
                      invalid={Boolean(segment.from && !validDay(segment.from))}
                      title={t("An empty field marks the explicit beginning of known history (origin).", "Puste pole oznacza jawny początek znanej historii (origin).")}
                    />
                  </Td>
                  <Td align="right">
                    <TextInput
                      value={segment.period}
                      onChange={(period) => patchSegment(segment.id, { period })}
                      width={62}
                      align="right"
                      disabled={!canEdit}
                      title={`${t("Segment", "Okres segmentu")} ${segment.id} ${t("in hours", "w godzinach")}`}
                      invalid={segment.period.trim() !== "" && !Number.isFinite(Number(segment.period))}
                    />
                  </Td>
                  <Td>
                    <TextInput
                      value={segment.anchor}
                      onChange={(anchor) => patchSegment(segment.id, { anchor })}
                      width={152}
                      placeholder="RRRR-MM-DDTGG:MM"
                      disabled={!canEdit}
                      title={`${t("Reset anchor for segment", "Kotwica resetu segmentu")} ${segment.id}`}
                      invalid={Boolean(segment.anchor.trim() && fromLocalInput(segment.anchor) == null)}
                    />
                  </Td>
                  <Td align="right">
                    <TextInput
                      value={segment.history}
                      onChange={(history) => patchSegment(segment.id, { history })}
                      width={54}
                      align="right"
                      disabled={!canEdit}
                      title={`${t("History window count for segment", "Liczba okien historii segmentu")} ${segment.id}`}
                    />
                  </Td>
                  <Td>
                    <TextInput
                      value={segment.note}
                      onChange={(note) => patchSegment(segment.id, { note })}
                      width={180}
                      placeholder={t("optional", "opcjonalnie")}
                      title={`${t("Note for segment", "Notatka segmentu")} ${segment.id}`}
                    />
                  </Td>
                  <Td align="right">
                    <GhostButton
                      onClick={() =>
                        setState((prev) => ({
                          ...prev,
                          draft: removeCadenceDraftSegment(prev.draft, segment.id),
                        }))
                      }
                      disabled={busy}
                      title={t("Remove this segment from the declaration draft", "Usuń ten odcinek z deklarowanego draftu")}
                    >
                      {t("remove", "usuń")}
                    </GhostButton>
                  </Td>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-4)", marginTop: "var(--s-5)", flexWrap: "wrap" }}>
        <GhostButton onClick={addSegment} disabled={busy} title={`${t("New segment from", "Nowy odcinek od")} ${asOf}`}>
          + {t("add segment from As of", "dodaj odcinek od Stan na dzień")}
        </GhostButton>
        <div style={{ display: "flex", gap: "var(--s-4)" }}>
          <GhostButton
            onClick={() => setState({ draft: cadenceDraftFromRow(row), error: null })}
            disabled={busy}
          >
            {t("revert draft", "cofnij draft")}
          </GhostButton>
          <GhostButton onClick={save} disabled={busy} title={t("Atomically replace the full cadence history", "Atomowo zastąp pełną historię rytmu")}>
            {busy ? t("saving…", "zapisuję…") : state.draft.length === 0 && row.declared ? t("remove declaration", "usuń deklarację") : t("save history", "zapisz historię")}
          </GhostButton>
        </div>
      </div>
      </div>
    </div>
  );
}
