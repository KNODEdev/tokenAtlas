import { useState } from "react";
import type { api, ProjectMatch, ApiProject } from "../../lib/api";
import { isBucket } from "../../../projects/bucket";
import type { useAsync } from "../../lib/useAsync";
import { compact, dayMonth, full, relativeTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { EmptyState, ErrorState, LoadingCard, Table, TableRow, Td, Th, GhostButton, Pill } from "../../components/ui";
import { VendorPills } from "./VendorPills";
import { ProjectEditor } from "./ProjectEditor";

export function ProjectRulesTable({
  state,
  onChanged,
}: {
  state: ReturnType<typeof useAsync<Awaited<ReturnType<typeof api.projects>>>>;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data) return <LoadingCard label={t("Loading projects…", "Wczytuję projekty…")} height={320} shape="table" />;
  const { projects, unassigned } = state.data;
  if (projects.length === 0) {
    return (
      <EmptyState
        title={t("No projects", "Brak projektów")}
        detail={t("Open the Unassigned tab and assign the first directory. This will create projects.json.", "Przejdź do zakładki Nieprzypisane i przypisz pierwszy katalog - to utworzy projects.json.")}
      />
    );
  }
  const rows = [...projects].sort(
    (a, b) => Number(isBucket(a.id)) - Number(isBucket(b.id)) || b.tokens - a.tokens,
  );
  return (
    <Table tableId="Projects:0">
      <thead>
        <TableRow header>
          <Th columnId="c0">{t("project", "projekt")}</Th>
          <Th columnId="c1">{t("rules", "reguły")}</Th>
          <Th columnId="c2" align="right">{t("calls", "wywołania")}</Th>
          <Th columnId="c3" align="right">{t("tokens", "tokeny")}</Th>
          <Th columnId="c4">{t("per vendor", "wg vendora")}</Th>
          <Th columnId="c5">{t("first", "pierwsze")}</Th>
          <Th columnId="c6">{t("last", "ostatnie")}</Th>
          <Th columnId="c7" align="right"> </Th>
        </TableRow>
      </thead>
      <tbody>
        {rows.map((p) => (
          <ProjectRowView
            key={p.id}
            project={p}
            projects={projects}
            open={open === p.id}
            onToggle={() => setOpen(open === p.id ? null : p.id)}
            onChanged={() => {
              setOpen(null);
              onChanged();
            }}
          />
        ))}
        <TableRow>
          <Td style={{ color: "var(--muted)", fontWeight: "var(--fw-medium)" }}>{t("unassigned", "nieprzypisane")}</Td>
          <Td mono style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>
            {t("no rule", "bez reguły")}
          </Td>
          <Td align="right" mono>
            {full(unassigned.calls)}
          </Td>
          <Td align="right" mono title={full(unassigned.tokens)}>
            {compact(unassigned.tokens)}
          </Td>
          <Td>
            <VendorPills vendors={unassigned.vendors} />
          </Td>
          <Td mono style={{ color: "var(--muted)" }}>
            {dayMonth(unassigned.first_ts)}
          </Td>
          <Td mono style={{ color: "var(--muted)" }}>
            {relativeTime(unassigned.last_ts)}
          </Td>
          <Td> </Td>
        </TableRow>
      </tbody>
    </Table>
  );
}

function ruleLabel(m: ProjectMatch): string {
  const head = m.store ? `[${m.store}] ` : "";
  const body = m.cwd ?? (m.repo ? `repo=${m.repo}` : `project=${m.project}`);
  const dates = m.from || m.until ? ` (${m.from ?? "…"} → ${m.until ?? "…"})` : "";
  return head + body + dates;
}

function ProjectRowView({
  project,
  projects,
  open,
  onToggle,
  onChanged,
}: {
  project: ApiProject;
  projects: ApiProject[];
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <TableRow>
        <Td>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: "var(--fw-medium)" }}>{project.name}</span>
            {isBucket(project.id) && (
              <Pill tone="warn">{t("bucket", "worek")}</Pill>
            )}
          </div>
          <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>
            {project.id}
          </div>
        </Td>
        <Td mono style={{ whiteSpace: "normal", maxWidth: 360 }}>
          {project.matches.map((m, i) => (
            <div key={i} style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }} title={JSON.stringify(m)}>
              {ruleLabel(m)}
            </div>
          ))}
        </Td>
        <Td align="right" mono>
          {full(project.calls)}
        </Td>
        <Td align="right" mono title={full(project.tokens)}>
          {compact(project.tokens)}
        </Td>
        <Td>
          <VendorPills vendors={project.vendors} />
        </Td>
        <Td mono style={{ color: "var(--muted)" }}>
          {dayMonth(project.first_ts)}
        </Td>
        <Td mono style={{ color: "var(--muted)" }} title={project.last_ts ?? ""}>
          {relativeTime(project.last_ts)}
        </Td>
        <Td align="right">
          <GhostButton onClick={onToggle}>{open ? t("close", "zamknij") : t("edit", "edytuj")}</GhostButton>
        </Td>
      </TableRow>
      {open && (
        <TableRow>
          <Td colSpan={8} style={{ background: "var(--sunk)", whiteSpace: "normal" }}>
            <ProjectEditor project={project} projects={projects} onChanged={onChanged} />
          </Td>
        </TableRow>
      )}
    </>
  );
}
