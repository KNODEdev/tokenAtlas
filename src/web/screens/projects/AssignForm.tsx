import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, type ApiProject, type ProjectMatch, type UnassignedRow } from "../../lib/api";
import { BUCKET_NAME, withoutBucket } from "../../../projects/bucket";
import { compact, full } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { GhostButton, HelpDot, Pill, Selector } from "../../components/ui";
import { ruleFor, catches, slugOf, type Track } from "./assignment";

export function AssignForm({
  row,
  rows,
  stores,
  partial,
  base,
  source,
  projects,
  onPreview,
  track,
  onAssigned,
}: {
  row: UnassignedRow;
  rows: UnassignedRow[];
  /** Accounts/stores the row (or its group) spans; each can narrow the rule. */
  stores: string[];
  partial: boolean;
  base: string;
  source: string | null;
  projects: ApiProject[];
  onPreview: (rule: ProjectMatch | null) => void;
  track: Track;
  onAssigned: () => void;
}) {
  const { t } = useI18n();
  const NEW = "__new__";
  const suggested = useMemo(() => {
    const want = slugOf(base);
    if (!want) return null;
    return projects.find((p) => p.id.toLowerCase() === want || slugOf(p.name) === want) ?? null;
  }, [projects, base]);
  const [target, setTarget] = useState<string>(suggested?.id ?? NEW);
  const [newId, setNewId] = useState(slugOf(base));
  const [newName, setNewName] = useState(base);
  // "" = this path on every machine; otherwise the one store the rule is limited to.
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const projectOptions = useMemo(
    () => [
      { value: NEW, label: `+ ${t("new project", "nowy projekt")}` },
      ...withoutBucket(projects)
        .filter((p) => p.id !== source)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: p.id, label: p.name })),
    ],
    [projects, source, t],
  );
  const match = useMemo(() => ruleFor(row, base), [row, base]);
  const rule = useMemo(() => (!source && scope ? { store: scope, ...match } : match), [source, scope, match]);
  // The other listed rows this rule also catches carry the same marker while the form is open.
  useEffect(() => onPreview(rule), [rule, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);
  const caught = useMemo(() => rows.filter((r) => catches(rule, r)), [rows, rule]);
  const caughtTokens = caught.reduce((sum, r) => sum + r.tokens, 0);
  const canSave = !busy && !(target === NEW && (!newId || !newName));
  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const to = target === NEW ? { new: { id: newId, name: newName } } : { project_id: target };
      await track(rule, "+", () =>
        source
          ? api.projectsReassign({
              from: source,
              match,
              ...(target === NEW ? { new: { id: newId, name: newName } } : { to: target }),
              drop_empty: true,
            })
          : api.projectsAssign({ match: rule, ...to }),
      );
      onAssigned();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "2px 0" }}>
      <Selector label={t("to", "do")} value={target} onChange={setTarget} options={projectOptions} strong />
      {suggested && target === suggested.id && (
        <Pill tone="ok" dot>
          {t("directory name = existing project", "nazwa katalogu = istniejący projekt")}
        </Pill>
      )}
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
            style={{ width: 220 }}
          />
          <input
            value={newId}
            onChange={(e) => setNewId(slugOf(e.target.value))}
            onKeyDown={submitOnEnter}
            placeholder={t("id", "id")}
            aria-label={t("Project ID", "Id projektu")}
            className="ui-input"
            style={{ width: 150 }}
          />
        </>
      )}
      {!source && (
        <Selector
          label={t("scope", "zakres")}
          value={scope}
          onChange={setScope}
          options={[
            { value: "", label: t("this path on every machine", "ta ścieżka na każdej maszynie") },
            ...stores.map((s) => ({ value: s, label: `${t("only", "tylko")} ${s}` })),
          ]}
        />
      )}
      <GhostButton onClick={submit} disabled={!canSave}>
        {busy ? t("saving…", "zapisuję…") : t("save and remap", "zapisz i przelicz")}
      </GhostButton>
      <span className="mono projects-caught" title={full(caughtTokens)}>
        <span className="projects-mark">+</span>
        {partial ? "≥ " : ""}
        {caught.length} · {compact(caughtTokens)}
      </span>
      <HelpDot label={t("Rule", "Reguła")}>
        {t("rule: ", "reguła: ")}
        {rule.store ? `[${rule.store}] ` : ""}
        {rule.cwd ? `cwd = ${rule.cwd}` : `(basename) ${rule.project}`}
        {` · ${t("+ marks the listed rows it catches, subdirectories included", "+ oznacza wiersze z listy, które łapie, razem z podkatalogami")}`}
        {partial ? ` · ${t("≥: rows outside the current list are not counted", "≥: wiersze spoza bieżącej listy nie są liczone")}` : ""}
        {` · ${t("when the directory is renamed, add another rule to the same project", "zmiana nazwy katalogu = dopisz kolejną regułę do tego samego projektu")}`}
        {source ? ` · ${t("the bucket rule for this directory will disappear in the same save", `reguła worka ${BUCKET_NAME} dla tego katalogu zniknie w tym samym zapisie`)}` : ""}
      </HelpDot>
      {err && (
        <span className="mono" style={{ color: "var(--crit)", fontSize: "var(--fs-3)" }}>
          {err}
        </span>
      )}
    </div>
  );
}
