import { type ProjectMatch, api, type ApiProject } from "../../lib/api";
import { useMemo, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { GhostButton, Selector, TextInput } from "../../components/ui";
import { idOf } from "./assignment";

type RuleKind = "cwd" | "repo" | "project";

function kindOf(m: ProjectMatch): RuleKind {
  if (m.repo !== undefined) return "repo";
  if (m.project !== undefined && m.cwd === undefined) return "project";
  return "cwd";
}

function valueOf(m: ProjectMatch): string {
  return m.cwd ?? m.repo ?? m.project ?? "";
}

function withValue(m: ProjectMatch, kind: RuleKind, value: string): ProjectMatch {
  const next: ProjectMatch = { ...m };
  delete next.cwd;
  delete next.repo;
  delete next.project;
  if (value.trim()) next[kind] = kind === "cwd" ? value.trim().replace(/\\/g, "/") : value.trim();
  return next;
}

function withStore(m: ProjectMatch, store: string): ProjectMatch {
  const next: ProjectMatch = { ...m };
  if (store.trim()) next.store = store.trim();
  else delete next.store;
  return next;
}

export function ProjectEditor({
  project,
  projects,
  onChanged,
}: {
  project: ApiProject;
  projects: ApiProject[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(project.name);
  const [id, setId] = useState(project.id);
  const [matches, setMatches] = useState<ProjectMatch[]>(() => project.matches.map((m) => ({ ...m })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty =
    name !== project.name || id !== project.id || JSON.stringify(matches) !== JSON.stringify(project.matches);
  const valid = name.trim().length > 0 && /^[a-z0-9_][a-z0-9_-]*$/i.test(id) && matches.every((m) => valueOf(m).trim());
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const save = () =>
    run(() => api.projectsUpdate({ project_id: project.id, new_id: id, name, matches }));
  const moveTargets = useMemo(
    () => [
      { value: "", label: t("move rule to…", "przenieś regułę do…") },
      ...projects
        .filter((p) => p.id !== project.id)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: p.id, label: p.name })),
    ],
    [projects, project.id, t],
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>
          {t("Name", "Nazwa")}
        </span>
        <TextInput value={name} onChange={setName} width={220} invalid={!name.trim()} />
        <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>
          ID
        </span>
        <TextInput
          value={id}
          onChange={(v) => setId(idOf(v))}
          width={150}
          invalid={!/^[a-z0-9_][a-z0-9_-]*$/i.test(id)}
          title={t(
            "Changing the ID is safe: project_id is derived in the database and remap rewrites it automatically.",
            "Zmiana id jest bezpieczna: project_id w bazie jest wyprowadzony i remap przepisuje go sam.",
          )}
        />
        <GhostButton onClick={save} disabled={busy || !dirty || !valid}>
          {busy ? t("saving…", "zapisuję…") : t("save and remap", "zapisz i przelicz")}
        </GhostButton>
        {dirty && !busy && (
          <GhostButton
            onClick={() => {
              setName(project.name);
              setId(project.id);
              setMatches(project.matches.map((m) => ({ ...m })));
              setErr(null);
            }}
          >
            {t("discard changes", "odrzuć zmiany")}
          </GhostButton>
        )}
        <div style={{ flex: 1 }} />
        {confirmDelete ? (
          <>
            <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--crit)" }}>
              {t("Delete “", "usunąć „")}{project.name}{t("”? Events remain and return to Unassigned", "”? eventy zostają - wracają do Nieprzypisane")}
            </span>
            <GhostButton
              onClick={() => run(() => api.projectsUpdate({ project_id: project.id, delete: true }))}
              disabled={busy}
            >
              {t("yes, delete", "tak, usuń")}
            </GhostButton>
            <GhostButton onClick={() => setConfirmDelete(false)}>{t("cancel", "anuluj")}</GhostButton>
          </>
        ) : (
          <GhostButton
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            title={t("Deletes the declaration, not usage", "Usuwa deklarację, nie zużycie")}
          >
            {t("delete project", "usuń projekt")}
          </GhostButton>
        )}
      </div>
      {matches.map((m, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Selector
            value={kindOf(m)}
            onChange={(v) => setMatches(matches.map((x, j) => (j === i ? withValue(x, v as RuleKind, valueOf(x)) : x)))}
            options={[
              { value: "cwd", label: t("path", "ścieżka") },
              { value: "repo", label: t("repo", "repo") },
              { value: "project", label: t("basename", "nazwa bazowa") },
            ]}
          />
          <TextInput
            value={valueOf(m)}
            onChange={(v) => setMatches(matches.map((x, j) => (j === i ? withValue(x, kindOf(x), v) : x)))}
            width={360}
            invalid={!valueOf(m).trim()}
            placeholder="C:/projects/example"
          />
          <TextInput
            value={m.store ?? ""}
            onChange={(v) => setMatches(matches.map((x, j) => (j === i ? withStore(x, v) : x)))}
            width={130}
            placeholder={t("any machine", "każda maszyna")}
            title={t("Limit the rule to one account / store. Empty means everywhere.", "Ogranicz regułę do jednego konta / store. Puste = wszędzie.")}
          />
          {(m.from || m.until) && (
            <span
              className="mono"
              style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}
              title={t("Edit the date range in projects.json", "Zakres dat edytuje się w projects.json")}
            >
              {m.from ?? "…"} → {m.until ?? "…"}
            </span>
          )}
          {!dirty && (
            <Selector
              value=""
              onChange={(to) => {
                if (!to) return;
                void run(() => api.projectsReassign({ from: project.id, index: i, to }));
              }}
              options={moveTargets}
            />
          )}
          <GhostButton
            onClick={() => setMatches(matches.filter((_, j) => j !== i))}
            title={t(
              "Remove the rule - the directory returns to Unassigned or to another matching rule.",
              "Usuń regułę - katalog wróci do Nieprzypisane (albo pod inną regułę, która go łapie)",
            )}
          >
            ×
          </GhostButton>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <GhostButton onClick={() => setMatches([...matches, { cwd: "" }])}>+ {t("add rule", "dodaj regułę")}</GhostButton>
        {matches.length === 0 && (
          <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>
            {t("without rules this project no longer matches anything", "bez reguł ten projekt nie łapie już niczego")}
          </span>
        )}
        {dirty && (
          <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--warn)" }}>
            {t("unsaved changes - moving rules is disabled until saving", "niezapisane zmiany - przenoszenie reguł zablokowane do zapisu")}
          </span>
        )}
      </div>
      {err && (
        <span className="mono" style={{ color: "var(--crit)", fontSize: "var(--fs-3)" }}>
          {err}
        </span>
      )}
      <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>
        {t(
          "A path rule also matches subdirectories · the first matching rule wins, and account rules come before the others · every save remaps project_id across the full index",
          "reguła po ścieżce łapie też podkatalogi · pierwsza pasująca reguła wygrywa, a reguły z kontem idą przed pozostałymi · każdy zapis przelicza project_id w całym indeksie",
        )}
      </span>
    </div>
  );
}
