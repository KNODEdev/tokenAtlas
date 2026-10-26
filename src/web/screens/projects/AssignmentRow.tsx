import { type ApiProject, type ProjectMatch, type UnassignedRow, api } from "../../lib/api";
import type { RosterCard } from "../../lib/roster";
import {
  type Pending,
  type Track,
  type Translate,
  countLabel,
  storePresentation,
  basename,
  ruleFor,
  vendorTone,
} from "./assignment";
import { useState } from "react";
import { BUCKET_ID, BUCKET_NAME } from "../../../projects/bucket";
import { compact, full, relativeTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { GhostButton, Pill, TableRow, Td } from "../../components/ui";
import { AssignForm } from "./AssignForm";

export type AssignmentRowProps = {
  row: UnassignedRow;
  rows: UnassignedRow[];
  partial: boolean;
  source: string | null;
  projects: ApiProject[];
  cards: RosterCard[];
  mark: { mark: Pending["mark"]; saving: boolean } | null;
  open: boolean;
  onToggle: () => void;
  onPreview: (rule: ProjectMatch | null) => void;
  track: Track;
  onError: (message: string) => void;
  onAssigned: () => void;
  /** Set on a directory's summary line when several vendors/accounts share it. */
  members?: UnassignedRow[];
  expanded?: boolean;
  onExpand?: () => void;
  /** One vendor/account line under an expanded summary. */
  nested?: boolean;
};

function groupStore(members: UnassignedRow[], cards: RosterCard[], t: Translate): { label: string; title?: string } {
  const each = members.map((m) => storePresentation(m, cards, t));
  const labels = [...new Set(each.map((s) => s.label))];
  if (labels.length === 1) return each[0]!;
  return { label: `${labels.length} ${countLabel(t, labels.length, "account", "accounts", "konto", "konta", "kont")}`, title: labels.join("\n") };
}

export function AssignmentRow({
  row,
  rows,
  partial,
  source,
  projects,
  cards,
  mark,
  open,
  onToggle,
  onPreview,
  track,
  onError,
  onAssigned,
  members,
  expanded,
  onExpand,
  nested,
}: AssignmentRowProps) {
  const { t } = useI18n();
  const store = members ? groupStore(members, cards, t) : storePresentation(row, cards, t);
  const vendors = members ? [...new Set(members.map((m) => m.vendor))] : [row.vendor];
  const stores = [...new Set((members ?? [row]).map((m) => m.store))];
  const base = basename(row.cwd, row.project);
  const [busy, setBusy] = useState(false);
  const write = async (rule: ProjectMatch, sign: Pending["mark"], fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await track(rule, sign, fn);
      onAssigned();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const toBucket = () => {
    const match = ruleFor(row, base);
    return write(match, "+", () => api.projectsAssign({ match, project_id: BUCKET_ID, new: { id: BUCKET_ID, name: BUCKET_NAME } }));
  };
  const outOfBucket = () => {
    if (!source) return;
    const match = ruleFor(row, base);
    return write(match, "↩", () => api.projectsReassign({ from: source, match, drop_empty: true }));
  };
  const saving = !!mark?.saving;
  return (
    <>
      <TableRow
        className={`projects-assign-row${nested ? " is-nested" : ""}${saving ? " is-saving" : mark ? " is-caught" : ""}`}
        aria-busy={saving || undefined}
      >
        <Td>
          <div style={{ display: "flex", gap: 4 }}>
            {vendors.map((v) => (
              <Pill key={v} tone={vendorTone(v)}>
                {v}
              </Pill>
            ))}
          </div>
        </Td>
        <Td mono style={{ color: "var(--muted)" }} title={store.title}>
          {store.label}
        </Td>
        <Td mono title={row.cwd ?? undefined} style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis" }}>
          {members && (
            <button
              type="button"
              className="projects-expand"
              aria-expanded={!!expanded}
              onClick={onExpand}
              title={`${members.length} ${countLabel(t, members.length, "entry", "entries", "wpis", "wpisy", "wpisów")}`}
            >
              {expanded ? "▾" : "▸"} {members.length}
            </button>
          )}
          {mark && (
            <span
              className="projects-mark"
              title={mark.mark === "+" ? t("caught by this rule", "łapie go ta reguła") : t("leaves the bucket", "wraca z worka")}
            >
              {mark.mark}
            </span>
          )}
          {row.cwd ?? <span style={{ color: "var(--faint)" }}>({t("no cwd", "brak cwd")}) {row.project}</span>}
        </Td>
        <Td align="right" mono>
          {full(row.calls)}
        </Td>
        <Td align="right" mono title={full(row.tokens)}>
          {compact(row.tokens)}
        </Td>
        <Td mono style={{ color: "var(--muted)" }} title={row.last_ts}>
          {relativeTime(row.last_ts)}
        </Td>
        <Td align="right">
          <div style={{ display: "inline-flex", gap: 6 }}>
            {source ? (
              <GhostButton
                onClick={outOfBucket}
                disabled={busy || saving}
                title={t("Remove the bucket rule for this directory - it returns to Unassigned", "Skasuj regułę worka dla tego katalogu - wróci do Nieprzypisane")}
              >
                {busy ? "…" : `↩ ${t("take out", "wyjmij")}`}
              </GhostButton>
            ) : (
              <GhostButton
                onClick={toBucket}
                disabled={busy || saving}
                title={`${t("Put into bucket ", "Wrzuć do worka ")}${BUCKET_NAME}: ${t("it leaves this list, tokens still count, and it can be taken out with one click", "znika z tej listy, tokeny nadal się liczą, wyjąć można jednym kliknięciem")}`}
              >
                {busy ? "…" : `→ ${BUCKET_NAME}`}
              </GhostButton>
            )}
            <GhostButton onClick={onToggle} disabled={saving}>{open ? t("close", "zamknij") : t("assign", "przypisz")}</GhostButton>
          </div>
        </Td>
      </TableRow>
      {open && (
        <TableRow>
          <Td colSpan={7} style={{ background: "var(--sunk)", whiteSpace: "normal" }}>
            <AssignForm
              row={row}
              rows={rows}
              stores={stores}
              partial={partial}
              base={base}
              source={source}
              projects={projects}
              onPreview={onPreview}
              track={track}
              onAssigned={onAssigned}
            />
          </Td>
        </TableRow>
      )}
    </>
  );
}
