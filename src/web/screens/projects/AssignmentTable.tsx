import { Fragment, useEffect, useMemo, useState } from "react";
import type { ApiProject, ProjectMatch, UnassignedRow } from "../../lib/api";
import { BUCKET_NAME } from "../../../projects/bucket";
import type { RosterCard } from "../../lib/roster";
import { useI18n } from "../../lib/i18n";
import { EmptyState, ErrorState, GhostButton, HelpDot, LoadingCard, Table, TableRow, Th } from "../../components/ui";
import { countLabel, rowKey, catches, type PathGroup, groupByPath, type Pending } from "./assignment";
import { type AssignmentRowProps, AssignmentRow } from "./AssignmentRow";

export function AssignmentTable({
  source,
  rows,
  total,
  totalAll,
  query,
  onQuery,
  pending,
  loading,
  error,
  projects,
  cards,
  onRetry,
  onAssigned,
}: {
  source: string | null;
  rows: UnassignedRow[];
  total: number;
  totalAll: number;
  query: string;
  onQuery: (q: string) => void;
  pending: boolean;
  loading: boolean;
  error: string | null;
  projects: ApiProject[];
  cards: RosterCard[];
  onRetry: () => void;
  onAssigned: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectMatch | null>(null);
  const [writes, setWrites] = useState<Pending[]>([]);
  // A finished write keeps its rows greyed until the reload that drops them arrives.
  useEffect(() => setWrites((w) => (w.some((x) => x.done) ? w.filter((x) => !x.done) : w)), [rows]);
  const track = async (rule: ProjectMatch, mark: Pending["mark"], write: () => Promise<unknown>) => {
    const entry: Pending = { rule, mark, done: false };
    setWrites((w) => [...w, entry]);
    try {
      await write();
      setWrites((w) => w.map((x) => (x === entry ? { ...x, done: true } : x)));
    } catch (e) {
      setWrites((w) => w.filter((x) => x !== entry));
      throw e;
    }
  };
  const markOf = (r: UnassignedRow): { mark: Pending["mark"]; saving: boolean } | null => {
    const write = writes.find((w) => catches(w.rule, r));
    if (write) return { mark: write.mark, saving: true };
    return preview && catches(preview, r) ? { mark: "+", saving: false } : null;
  };
  const groups = useMemo(() => groupByPath(rows), [rows]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const groupMark = (g: PathGroup) => {
    const marks = g.members.map(markOf);
    return marks.find((m) => m?.saving) ?? marks.find((m) => m) ?? null;
  };
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  const search = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "0 0 10px" }}>
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={t("search path: repos clients, mesflow, OneDrive…", "szukaj w ścieżce: repos clients, mesflow, OneDrive…")}
        aria-label={t("Search directory paths", "Szukaj w ścieżkach katalogów")}
        className="ui-input"
        style={{ width: 380, maxWidth: "100%" }}
      />
      {query && (
        <GhostButton onClick={() => onQuery("")} title={t("Clear filter", "Wyczyść filtr")}>
          × {t("clear", "wyczyść")}
        </GhostButton>
      )}
      <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>
        {pending
          ? t("searching…", "szukam…")
          : query
            ? `${total} ${t("of", "z")} ${totalAll} ${countLabel(t, totalAll, "directory matches", "directories match", "katalog pasuje", "katalogi pasują", "katalogów pasuje")}`
            : total > rows.length
              ? `${t("showing", "pokazuję")} ${rows.length} ${t("of", "z")} ${total} ${countLabel(t, total, "directory", "directories", "katalog", "katalogi", "katalogów")} ${t("(largest first)", "(największe najpierw)")}`
              : `${total} ${countLabel(t, total, "directory", "directories", "katalog", "katalogi", "katalogów")}`}
      </span>
      <HelpDot label={source ? `${t("bucket contents", "zawartość worka")} ${BUCKET_NAME}` : t("Search", "Wyszukiwanie")}>
        {source
          ? `${t("bucket contents", "zawartość worka")} ${BUCKET_NAME} · ${t("“↩ take out” removes the rule and returns the directory to Unassigned", "„↩ wyjmij” kasuje regułę i katalog wraca do Nieprzypisane")}`
          : t("words are joined with AND · searches path, account, and vendor", "słowa łączą się przez I · szuka w ścieżce, koncie i vendorze")}
      </HelpDot>
    </div>
  );
  if (loading)
    return (
      <>
        {search}
        <LoadingCard label={t("Loading directories…", "Wczytuję katalogi…")} shape="table" />
      </>
    );
  if (rows.length === 0) {
    return (
      <>
        {search}
        {query ? (
          <EmptyState
            title={`${t("Nothing matches “", "Nic nie pasuje do „")}${query}${t("”", "”")}`}
            detail={`${t("None of", "Żaden z")} ${totalAll} ${countLabel(t, totalAll, "directories in this pool contain", "directories in this pool contain", "katalog w tej puli zawiera", "katalogi w tej puli zawierają", "katalogów w tej puli zawiera")} ${t("all entered words. Try one word or a path fragment.", "wszystkich wpisanych słów. Spróbuj jednego słowa albo fragmentu ścieżki.")}`}
          />
        ) : source ? (
          <EmptyState
            title={`${t("Bucket ", "Worek ")}${BUCKET_NAME} ${t("is empty", "jest pusty")}`}
            detail={t(
              'In the "Unassigned" tab, every row has a "→ _TMP" button - directories you do not want to assign land here and stay out of the backlog.',
              'W zakładce "Nieprzypisane" każdy wiersz ma przycisk "→ _TMP" - katalogi, których nie chcesz przypisywać, lądują tutaj i nie zaśmiecają backlogu.',
            )}
          />
        ) : (
          <EmptyState
            title={t("Everything is assigned", "Wszystko przypisane")}
            detail={t("Every directory with events has a project. New ones appear here after sync.", "Każdy katalog z eventami ma projekt. Nowe pojawią się tu po syncu.")}
          />
        )}
      </>
    );
  }
  return (
    <>
      {search}
      {err && (
        <div className="mono" style={{ color: "var(--crit)", fontSize: "var(--fs-3)", padding: "0 0 8px" }}>
          {err}
        </div>
      )}
      <Table tableId="Projects:1">
        <thead>
          <TableRow header>
            <Th columnId="c0">{t("vendor", "dostawca")}</Th>
            <Th columnId="c1">{t("account / store", "konto / sklep")}</Th>
            <Th columnId="c2">cwd</Th>
            <Th columnId="c3" align="right">{t("calls", "wywołania")}</Th>
            <Th columnId="c4" align="right">{t("tokens", "tokeny")}</Th>
            <Th columnId="c5">{t("last", "ostatnie")}</Th>
            <Th columnId="c6" align="right"> </Th>
          </TableRow>
        </thead>
        <tbody>
          {groups.map((g) => {
            const grouped = g.members.length > 1;
            const isExpanded = grouped && expanded.has(g.key);
            const view = (r: UnassignedRow, key: string, extra: Partial<AssignmentRowProps>) => (
              <AssignmentRow
                key={key}
                row={r}
                rows={rows}
                partial={!!query || total > rows.length}
                source={source}
                projects={projects}
                cards={cards}
                mark={markOf(r)}
                open={open === key}
                onToggle={() => {
                  setPreview(null);
                  setOpen(open === key ? null : key);
                }}
                onPreview={setPreview}
                track={track}
                onError={setErr}
                onAssigned={() => {
                  setOpen(null);
                  setPreview(null);
                  setErr(null);
                  onAssigned();
                }}
                {...extra}
              />
            );
            if (!grouped) return view(g.head, rowKey(g.head), {});
            return (
              <Fragment key={g.key}>
                {view(g.head, `g:${g.key}`, {
                  members: g.members,
                  mark: groupMark(g),
                  expanded: isExpanded,
                  onExpand: () =>
                    setExpanded((s) => {
                      const next = new Set(s);
                      if (!next.delete(g.key)) next.add(g.key);
                      return next;
                    }),
                })}
                {isExpanded && g.members.map((m) => view(m, rowKey(m), { nested: true }))}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
