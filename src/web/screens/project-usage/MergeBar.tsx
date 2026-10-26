import { useMemo, useState } from "react";
import { withoutBucket } from "../../../projects/bucket";
import { GhostButton, Selector } from "../../components/ui";
import { api, type ApiProject, type SubjectRow } from "../../lib/api";
import { compact } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { slugOf } from "../projects/assignment";
import { countLabel } from "./format";

function leafName(s: string): string {
  const parts = s.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? s;
}
const NEW_PROJECT = "__new__";
export function MergeBar({
  picked,
  projects,
  onClear,
  onMerged,
}: {
  picked: SubjectRow[];
  projects: ApiProject[];
  onClear: () => void;
  onMerged: () => void;
}) {
  const { t } = useI18n();
  const [targetOverride, setTargetOverride] = useState<string | null>(null);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pickedProject = picked.find((p) => p.kind === "project");
  const biggest = [...picked].sort((a, b) => b.tokens - a.tokens)[0];
  const target = targetOverride ?? pickedProject?.id ?? NEW_PROJECT;
  const name = nameOverride ?? leafName(biggest?.name ?? "");
  const id = idOverride ?? slugOf(name);
  const options = useMemo(
    () => [
      { value: NEW_PROJECT, label: `+ ${t("new project", "nowy projekt")}` },
      ...withoutBucket(projects).sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name })),
    ],
    [projects, t],
  );
  const totalTokens = picked.reduce((s, p) => s + p.tokens, 0);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.projectsMerge({
        subjects: picked.map((p) => ({ kind: p.kind, id: p.id })),
        ...(target === NEW_PROJECT ? { new: { id, name } } : { project_id: target }),
      });
      setTargetOverride(null);
      setNameOverride(null);
      setIdOverride(null);
      onMerged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      style={{
        margin: "0 0 var(--s-5)",
        padding: "var(--s-5) var(--s-6)",
        borderRadius: "var(--r-chip)",
        background: "var(--sunk)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)" }}>
          {picked.length} {countLabel(t, picked.length, "item", "items", "pozycja", "pozycje", "pozycji")} · {compact(totalTokens)} {t("tok", "tok")}
        </span>
        <Selector label={t("merge into", "scal w")} value={target} onChange={setTargetOverride} options={options} strong />
        {target === NEW_PROJECT && (
          <>
            <input
              value={name}
              onChange={(e) => {
                setNameOverride(e.target.value);
                setIdOverride(slugOf(e.target.value));
              }}
              placeholder={t("name", "nazwa")}
              aria-label={t("Project name", "Nazwa projektu")}
              className="ui-input"
              style={{ width: 200 }}
            />
            <input
              value={id}
              onChange={(e) => setIdOverride(slugOf(e.target.value))}
              placeholder={t("id", "id")}
              aria-label={t("Project ID", "Id projektu")}
              className="ui-input"
              style={{ width: 150 }}
            />
          </>
        )}
        <GhostButton
          onClick={submit}
          disabled={busy || picked.length === 0 || (target === NEW_PROJECT && (!id || !name))}
          title={t("Adds the rules to projects.json and remaps project_id", "Dopisze reguły do projects.json i przeliczy project_id")}
        >
          {busy ? t("merging…", "scalam…") : t("merge and remap", "scal i przelicz")}
        </GhostButton>
        <GhostButton onClick={onClear} disabled={busy}>
          {t("clear", "wyczyść")}
        </GhostButton>
        {err && (
          <span className="mono" style={{ color: "var(--crit)", fontSize: "var(--fs-3)" }}>
            {err}
          </span>
        )}
      </div>
      <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)", marginTop: 6, lineHeight: 1.5 }}>
        {picked.map((p) => `${p.kind === "project" ? "◆" : "·"} ${p.name}`).join("   ")}
      </div>
      <div style={{ fontSize: "var(--fs-3)", color: "var(--faint)", marginTop: 4, lineHeight: 1.5 }}>
        {t(
          "The selected project is absorbed: its rules move to the target and the empty declaration disappears. Merging two declarations into one is the only way to record “this is the same project” once instead of as two rows with similar names.",
          "Zaznaczony projekt zostaje wchłonięty: jego reguły przechodzą do celu, a pusta deklaracja znika. Scalanie dwóch deklaracji w jedną to jedyny sposób, żeby „to jest ten sam projekt” zapisało się raz, a nie jako dwa wiersze o podobnej nazwie.",
        )}
      </div>
    </div>
  );
}
