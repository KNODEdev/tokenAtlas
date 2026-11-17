import { useMemo, useState, type KeyboardEvent } from "react";
import { api, type ApiProject, type ProjectMatch } from "../../lib/api";
import { BUCKET_ID, BUCKET_NAME, withoutBucket } from "../../../projects/bucket";
import { compact, full } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { GhostButton, Selector } from "../../components/ui";
import { bulkRules, countLabel, slugOf, type PathGroup, type Track } from "./assignment";

const NEW = "__new__";

/** One rule or several: a single rule goes as `match`, which every server version accepts. */
const ruleBody = (rules: ProjectMatch[]) => (rules.length === 1 ? { match: rules[0]! } : { matches: rules });

/** Actions on the selected directories: one save for all of them. */
export function BulkAssignBar({
  groups,
  source,
  projects,
  track,
  onDone,
  onClear,
}: {
  groups: PathGroup[];
  source: string | null;
  projects: ApiProject[];
  track: Track;
  onDone: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState(NEW);
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = useMemo(
    () => [
      { value: NEW, label: `+ ${t("new project", "nowy projekt")}` },
      ...withoutBucket(projects)
        .filter((p) => p.id !== source)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: p.id, label: p.name })),
    ],
    [projects, source, t],
  );
  const tokens = groups.reduce((sum, g) => sum + g.head.tokens, 0);
  const paths = groups.map((g) => g.head.cwd ?? g.head.project ?? "?");
  const canAssign = !busy && groups.length > 0 && !(target === NEW && (!newId || !newName.trim()));
  const run = async (mark: "+" | "↩", rules: ProjectMatch[], write: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await track(rules, mark, write);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const assign = () => {
    if (!canAssign) return;
    const to = target === NEW ? { new: { id: newId, name: newName.trim() } } : { project_id: target };
    if (source) {
      const rules = bulkRules(groups, false);
      const dest = target === NEW ? { new: to.new! } : { to: target };
      return run("+", rules, () => api.projectsReassign({ from: source, ...ruleBody(rules), ...dest, drop_empty: true }));
    }
    const rules = bulkRules(groups, true);
    return run("+", rules, () => api.projectsAssign({ ...ruleBody(rules), ...to }));
  };
  const toBucket = () => {
    const rules = bulkRules(groups, true);
    return run("+", rules, () => api.projectsAssign({ ...ruleBody(rules), project_id: BUCKET_ID, new: { id: BUCKET_ID, name: BUCKET_NAME } }));
  };
  const takeOut = () => {
    if (!source) return;
    const rules = bulkRules(groups, false);
    return run("↩", rules, () => api.projectsReassign({ from: source, ...ruleBody(rules), drop_empty: true }));
  };
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void assign();
    }
  };
  return (
    <div className="projects-bulk" role="group" aria-label={t("Selected directories", "Zaznaczone katalogi")}>
      <span className="mono projects-bulk-count" title={`${full(tokens)} ${t("tokens", "tokenów")}\n${paths.join("\n")}`}>
        {groups.length} {countLabel(t, groups.length, "selected", "selected", "zaznaczony", "zaznaczone", "zaznaczonych")} · {compact(tokens)}
      </span>
      <Selector label={t("to", "do")} value={target} onChange={setTarget} options={options} strong />
      {target === NEW && (
        <>
          <input
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setNewId(slugOf(e.target.value));
            }}
            onKeyDown={submitOnEnter}
            placeholder={t("name", "nazwa")}
            aria-label={t("Project name", "Nazwa projektu")}
            className="ui-input"
            style={{ width: 200 }}
          />
          <input
            value={newId}
            onChange={(e) => setNewId(slugOf(e.target.value))}
            onKeyDown={submitOnEnter}
            placeholder={t("id", "id")}
            aria-label={t("Project ID", "Id projektu")}
            className="ui-input"
            style={{ width: 140 }}
          />
        </>
      )}
      <GhostButton onClick={assign} disabled={!canAssign}>
        {busy ? t("saving…", "zapisuję…") : t("assign selected", "przypisz zaznaczone")}
      </GhostButton>
      {source ? (
        <GhostButton
          onClick={takeOut}
          disabled={busy}
          title={t("Remove the bucket rules of the selected directories - they return to Unassigned", "Skasuj reguły worka zaznaczonych katalogów - wrócą do Nieprzypisane")}
        >
          ↩ {t("take out", "wyjmij")}
        </GhostButton>
      ) : (
        <GhostButton
          onClick={toBucket}
          disabled={busy}
          title={`${t("Put the selected directories into bucket ", "Wrzuć zaznaczone katalogi do worka ")}${BUCKET_NAME}`}
        >
          → {BUCKET_NAME}
        </GhostButton>
      )}
      <GhostButton onClick={onClear} disabled={busy} title={t("Clear the selection", "Wyczyść zaznaczenie")}>
        × {t("clear", "wyczyść")}
      </GhostButton>
      {err && <span className="mono projects-bulk-error">{err}</span>}
    </div>
  );
}
