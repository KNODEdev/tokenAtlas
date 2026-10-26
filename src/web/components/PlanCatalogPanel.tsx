import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogDefaultReference,
  CatalogPlan,
  CatalogPlanVersion,
  CatalogProviderGroup,
  PlanLimits,
  PlansCatalog,
} from "../lib/api";
import { api, PLAN_TOKEN_TYPES } from "../lib/api";
import { compact, usd } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { formatPlanLabel } from "../../shared/plan-label";
import { reasonLabel } from "./PlansTable";
import { TableRow, Card, CardTitle, GhostButton, Pill, Table, Td, Th, TextInput } from "./ui";
export interface PlanCatalogPanelProps {
  catalog: PlansCatalog;
  onSave?: (catalog: PlansCatalog) => Promise<unknown>;
  onSaved?: () => void;
  provider?: string;
  focusedPlanId?: string;
  focusedVersionId?: string;
  initialError?: string | null;
  onClose?: () => void;
}
export interface VersionDraft {
  from: string;
  usd_per_month: string;
  usd_per_month_annual: string;
  window_hours: string;
  weekly_cap: boolean;
  raw_limits?: PlanLimits | null;
  source: string;
  note: string;
  default_reference?: CatalogDefaultReference | null;
}
export interface PlanDraft {
  plan_id: string;
  label: string;
  aliases: string;
  versions: VersionDraft[];
}
export interface GroupDraft {
  id: string;
  label: string;
  aliases: string;
  plans: PlanDraft[];
}
export function versionToDraft(v: CatalogPlanVersion): VersionDraft {
  return {
    from: v.from ?? "",
    usd_per_month: v.usd_per_month != null ? String(v.usd_per_month) : "",
    usd_per_month_annual: v.usd_per_month_annual != null ? String(v.usd_per_month_annual) : "",
    window_hours: v.limits?.window_hours != null ? String(v.limits.window_hours) : "",
    weekly_cap: v.limits?.weekly_cap === true,
    raw_limits: v.limits ? { ...v.limits } : null,
    source: v.source ?? "",
    note: v.note ?? "",
    default_reference: v.default_reference ?? null,
  };
}
export function planToDraft(p: CatalogPlan): PlanDraft {
  return {
    plan_id: p.plan_id,
    label: p.label,
    aliases: (p.aliases ?? []).join(", "),
    versions: [...p.versions]
      .sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""))
      .map(versionToDraft),
  };
}
export function catalogToDraft(catalog: PlansCatalog): GroupDraft[] {
  return catalog.provider_groups.map((g) => ({
    id: g.id,
    label: g.label,
    aliases: (g.aliases ?? []).join(", "),
    plans: g.plans.map(planToDraft),
  }));
}
export function parseUsd(val: string): number | null | "invalid" {
  const t = val.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return n;
}
export type CatalogPayloadResult =
  | { ok: true; payload: PlansCatalog }
  | { ok: false; error: string };
export function validateAndBuildCatalogPayload(
  draftGroups: GroupDraft[],
  original: PlansCatalog
): CatalogPayloadResult {
  const provider_groups: CatalogProviderGroup[] = [];
  for (const g of draftGroups) {
    const plans: CatalogPlan[] = [];
    for (const p of g.plans) {
      const versions: CatalogPlanVersion[] = [];
      for (const v of p.versions) {
        const fromVal = v.from.trim();
        const usdMonthly = parseUsd(v.usd_per_month);
        if (usdMonthly === "invalid") {
          return {
            ok: false,
            error: translate(
              "Invalid monthly price \"{0}\" in plan {1}. Enter a non-negative dollar amount (for example, 20 or 20.50).",
              `Nieprawidłowa cena miesięczna "${v.usd_per_month}" w planie ${p.label || p.plan_id}. Wpisz nieujemną kwotę w dolarach (np. 20 lub 20.50).`, [v.usd_per_month, p.label || p.plan_id]
            ),
          };
        }
        const usdAnnual = parseUsd(v.usd_per_month_annual);
        if (usdAnnual === "invalid") {
          return {
            ok: false,
            error: translate(
              "Invalid annual price \"{0}\" in plan {1}. Enter a non-negative dollar amount.",
              `Nieprawidłowa cena roczna "${v.usd_per_month_annual}" w planie ${p.label || p.plan_id}. Wpisz nieujemną kwotę w dolarach.`, [v.usd_per_month_annual, p.label || p.plan_id]
            ),
          };
        }
        const winHoursVal = v.window_hours.trim().replace(",", ".");
        const limits: PlanLimits = v.raw_limits ? { ...v.raw_limits } : {};
        if (winHoursVal !== "") {
          const num = Number(winHoursVal);
          if (!Number.isFinite(num) || num <= 0) {
            return {
              ok: false,
              error: translate(
                "Invalid window length \"{0}\" in plan {1}. Enter a positive number of hours.",
                `Nieprawidłowa długość okna "${v.window_hours}" w planie ${p.label || p.plan_id}. Wpisz dodatnią liczbę godzin.`, [v.window_hours, p.label || p.plan_id]
              ),
            };
          }
          limits.window_hours = num;
        } else {
          delete limits.window_hours;
        }
        if (v.weekly_cap) {
          limits.weekly_cap = true;
        } else if ("weekly_cap" in limits) {
          delete limits.weekly_cap;
        }
        const outVersion: CatalogPlanVersion = {
          from: fromVal === "" ? null : fromVal,
          usd_per_month: usdMonthly,
        };
        if (usdAnnual != null) {
          outVersion.usd_per_month_annual = usdAnnual;
        }
        if (Object.keys(limits).length > 0) {
          outVersion.limits = limits;
        }
        if (v.source.trim() !== "") {
          outVersion.source = v.source.trim();
        }
        if (v.note.trim() !== "") {
          outVersion.note = v.note.trim();
        }
        versions.push(outVersion);
      }
      const aliasesArr = p.aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const outPlan: CatalogPlan = {
        plan_id: p.plan_id.trim(),
        label: p.label.trim(),
        versions: versions.sort((a, b) => (a.from ?? "").localeCompare(b.from ?? "")),
      };
      if (aliasesArr.length > 0) {
        outPlan.aliases = aliasesArr;
      }
      plans.push(outPlan);
    }
    provider_groups.push({
      id: g.id.trim(),
      label: g.label.trim(),
      aliases: g.aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
      plans,
    });
  }
  const result: PlansCatalog = { provider_groups };
  if (original._comment) {
    result._comment = original._comment;
  }
  return { ok: true, payload: result };
}
export function draftToCatalog(draftGroups: GroupDraft[], original: PlansCatalog): PlansCatalog {
  const res = validateAndBuildCatalogPayload(draftGroups, original);
  if (!res.ok) {
    throw new Error(res.error);
  }
  return res.payload;
}
export function extractSavedCatalog(response: unknown, fallbackPayload: PlansCatalog): PlansCatalog {
  if (response && typeof response === "object") {
    if ("catalog" in response && (response as { catalog: unknown }).catalog) {
      return (response as { catalog: PlansCatalog }).catalog;
    }
    if ("provider_groups" in response && Array.isArray((response as { provider_groups: unknown }).provider_groups)) {
      return response as PlansCatalog;
    }
  }
  return fallbackPayload;
}
export function PlanCatalogPanel({
  catalog,
  onSave,
  onSaved,
  provider = "all",
  focusedPlanId,
  focusedVersionId,
  initialError = null,
  onClose,
}: PlanCatalogPanelProps) {
  const { t } = useI18n();
  const baselineCatalogRef = useRef<PlansCatalog>(catalog);
  const [draftGroups, setDraftGroups] = useState<GroupDraft[]>(() => catalogToDraft(catalog));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [addingPlanToGroup, setAddingPlanToGroup] = useState<string | null>(null);
  const [newPlanId, setNewPlanId] = useState("");
  const [newPlanLabel, setNewPlanLabel] = useState("");
  const [newPlanAliases, setNewPlanAliases] = useState("");
  const baselineDraftJson = useMemo(() => JSON.stringify(catalogToDraft(baselineCatalogRef.current)), [baselineCatalogRef.current]);
  const currentDraftJson = useMemo(() => JSON.stringify(draftGroups), [draftGroups]);
  const isDirty = baselineDraftJson !== currentDraftJson;
  useEffect(() => {
    if (!isDirty && catalog !== baselineCatalogRef.current) {
      baselineCatalogRef.current = catalog;
      setDraftGroups(catalogToDraft(catalog));
    }
  }, [catalog, isDirty]);
  const filteredGroups = useMemo(() => {
    if (!provider || provider === "all") return draftGroups;
    const want = provider.toLowerCase();
    return draftGroups.filter(
      (g) => g.id.toLowerCase() === want || g.aliases.toLowerCase().includes(want)
    );
  }, [draftGroups, provider]);
  const patchPlan = (groupId: string, planId: string, part: Partial<PlanDraft>) => {
    setDraftGroups((groups) =>
      groups.map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          plans: g.plans.map((p) => (p.plan_id === planId ? { ...p, ...part } : p)),
        };
      })
    );
  };
  const patchVersion = (groupId: string, planId: string, index: number, part: Partial<VersionDraft>) => {
    setDraftGroups((groups) =>
      groups.map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          plans: g.plans.map((p) => {
            if (p.plan_id !== planId) return p;
            const nextVersions = p.versions.map((v, i) => (i === index ? { ...v, ...part } : v));
            return { ...p, versions: nextVersions };
          }),
        };
      })
    );
  };
  const addVersion = (groupId: string, planId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const newVersion: VersionDraft = {
      from: today,
      usd_per_month: "",
      usd_per_month_annual: "",
      window_hours: "",
      weekly_cap: false,
      raw_limits: null,
      source: "",
      note: "",
      default_reference: null,
    };
    setDraftGroups((groups) =>
      groups.map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          plans: g.plans.map((p) => {
            if (p.plan_id !== planId) return p;
            return { ...p, versions: [...p.versions, newVersion] };
          }),
        };
      })
    );
  };
  const removeVersion = (groupId: string, planId: string, index: number) => {
    setDraftGroups((groups) =>
      groups.map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          plans: g.plans.map((p) => {
            if (p.plan_id !== planId) return p;
            return { ...p, versions: p.versions.filter((_, i) => i !== index) };
          }),
        };
      })
    );
  };
  const submitAddPlan = (groupId: string) => {
    const trimmedId = newPlanId.trim().toLowerCase();
    const trimmedLabel = newPlanLabel.trim() || trimmedId;
    if (!trimmedId) return;
    const newPlan: PlanDraft = {
      plan_id: trimmedId,
      label: trimmedLabel,
      aliases: newPlanAliases.trim(),
      versions: [
        {
          from: "",
          usd_per_month: "",
          usd_per_month_annual: "",
          window_hours: "",
          weekly_cap: false,
          raw_limits: null,
          source: "",
          note: "",
          default_reference: null,
        },
      ],
    };
    setDraftGroups((groups) =>
      groups.map((g) => {
        if (g.id !== groupId) return g;
        return { ...g, plans: [...g.plans, newPlan] };
      })
    );
    setAddingPlanToGroup(null);
    setNewPlanId("");
    setNewPlanLabel("");
    setNewPlanAliases("");
  };
  const handleSave = async () => {
    const buildRes = validateAndBuildCatalogPayload(draftGroups, baselineCatalogRef.current);
    if (!buildRes.ok) {
      setError(buildRes.error);
      return;
    }
    const payload = buildRes.payload;
    setBusy(true);
    setError(null);
    try {
      let res: unknown;
      if (onSave) {
        res = await onSave(payload);
      } else {
        res = await api.plansCatalogSave(payload);
      }
      const saved = extractSavedCatalog(res, payload);
      baselineCatalogRef.current = saved;
      setDraftGroups(catalogToDraft(saved));
      setError(null);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const handleReset = () => {
    setDraftGroups(catalogToDraft(baselineCatalogRef.current));
    setError(null);
    setAddingPlanToGroup(null);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-8)" }}>
      <Card>
        <CardTitle
          title={t("Provider plan catalog", "Katalog Planów dostawców")}
          help={t(
            "Source of truth for identities, versions, limits and curated references. Local edits are saved to configuration.",
            "Źródło prawdy dla tożsamości, wersji, limitów i kuratorowanych referencji. Edycja lokalna zapisuje do konfiguracji."
          )}
          right={
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {isDirty && (
                <Pill tone="accent" dot>
                  {t("draft changes", "zmiany robocze")}
                </Pill>
              )}
              <GhostButton onClick={handleReset} disabled={busy || !isDirty} title={t("Restore the saved catalog", "Przywróć zapisany stan katalogu")}>
                {t("cancel", "anuluj")}
              </GhostButton>
              <GhostButton
                onClick={handleSave}
                disabled={busy || !isDirty}
                title={t("Save catalog metadata to plans-catalog.json", "Zapisz metadane katalogu do plans-catalog.json")}
              >
                {busy ? t("saving…", "zapisuję…") : t("save plan catalog", "zapisz katalog Planów")}
              </GhostButton>
              {onClose && <GhostButton onClick={onClose}>{t("close", "zamknij")}</GhostButton>}
            </div>
          }
        />
        <div
          style={{
            marginTop: 12,
            padding: "var(--s-5) var(--s-7)",
            borderRadius: "var(--r-chip)",
            background: "var(--sunk)",
            fontSize: "var(--fs-4)",
            color: "var(--muted)",
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: "var(--text)" }}>{t("Catalog metadata versus subscription stages:", "Metadane katalogu vs etapy subskrypcji:")}</strong>{" "}
          {t(
            "Catalog editing changes public plan version metadata (catalog price, effective date, limits, and source). Individual discounts and account terms are entered as a stage override in the subscription drawer. The curated default reference is immutable at runtime and belongs to the repository release.",
            "Edycja katalogu modyfikuje publiczne metadane wersji Planu (cena katalogowa, data obowiązywania, limity, źródło). Indywidualne rabaty i warunki konta wprowadza się jako nadpis etapu w szufladzie Subskrypcji. Kuratorowana referencja domyślna jest niemutowalna w środowisku wykonawczym i należy do wydania w repozytorium."
          )}
        </div>
        {error && (
          <div
            role="alert"
            className="mono"
            style={{
              marginTop: 12,
              padding: "var(--s-5) var(--s-7)",
              borderRadius: "var(--r-chip)",
              background: "var(--crit-soft)",
              color: "var(--crit)",
              fontSize: "var(--fs-4)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            <div style={{ fontWeight: "var(--fw-semibold)", marginBottom: 2 }}>{t("Server refusal (save rejected):", "Odmowa serwera (zapis odrzucony):")}</div>
            {error}
          </div>
        )}
      </Card>
      {filteredGroups.length === 0 && (
        <Card>
          <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)", textAlign: "center" }}>
            {t("No provider groups match the filter", "Brak grup dostawców pasujących do filtra")} "{provider}".
          </div>
        </Card>
      )}
      {filteredGroups.map((group) => (
        <Card key={group.id}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
              borderBottom: "1px solid var(--line2)",
              paddingBottom: "var(--s-5)",
              marginBottom: "var(--s-7)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: "var(--fs-6)", color: "var(--text)", fontWeight: "var(--fw-semibold)" }}>
                {group.label} ({group.id})
              </div>
              {group.aliases && (
                <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                  {t("aliases", "aliasy")}: {group.aliases}
                </span>
              )}
              <Pill tone="neutral">{group.plans.length} {t("plans", "planów")}</Pill>
            </div>
            <GhostButton
              onClick={() => {
                setAddingPlanToGroup(addingPlanToGroup === group.id ? null : group.id);
                setNewPlanId("");
                setNewPlanLabel("");
                setNewPlanAliases("");
              }}
            >
              {addingPlanToGroup === group.id ? t("cancel adding a plan", "anuluj dodawanie Planu") : `+ ${t("add plan to group", "dodaj Plan do grupy")}`}
            </GhostButton>
          </div>
          {addingPlanToGroup === group.id && (
            <div
              style={{
                marginBottom: 16,
                padding: "var(--s-6) var(--s-7)",
                background: "var(--sunk)",
                borderRadius: "var(--r-chip)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: "var(--fw-semibold)", fontSize: "var(--fs-5)" }}>{t("New plan in group", "Nowy Plan w grupie")} {group.label}</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <TextInput
                  value={newPlanId}
                  onChange={setNewPlanId}
                  placeholder={t("plan_id, for example team-standard", "plan_id, np. team-standard")}
                  width={180}
                  title={t("Unique plan identifier", "Unikalny identyfikator Planu")}
                />
                <TextInput
                  value={newPlanLabel}
                  onChange={setNewPlanLabel}
                  placeholder={t("Label, for example Team Standard", "Etykieta, np. Team Standard")}
                  width={180}
                  title={t("Displayed plan name", "Nazwa wyświetlana Planu")}
                />
                <TextInput
                  value={newPlanAliases}
                  onChange={setNewPlanAliases}
                  placeholder={t("Aliases (comma-separated)", "Aliasy (oddzielone przecinkami)")}
                  width={220}
                  title={t("Aliases used to match queries for this plan", "Aliasy dopasowujące zapytania o ten Plan")}
                />
                <GhostButton onClick={() => submitAddPlan(group.id)} disabled={!newPlanId.trim()}>
                  {t("create plan", "utwórz Plan")}
                </GhostButton>
              </div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {group.plans.map((plan, planIndex) => {
              const isFocused = focusedPlanId && plan.plan_id.toLowerCase() === focusedPlanId.toLowerCase();
              const activeVersion = plan.versions.filter(version => !version.from || version.from <= new Date().toISOString().slice(0, 10)).at(-1);
              return (
                <div
                  key={plan.plan_id}
                  data-plan-editor={plan.plan_id}
                  style={{
                    // Plans are groups divided by rules; the focused one gets an accent wash, not a frame.
                    borderTop: planIndex > 0 ? "var(--rule)" : undefined,
                    padding: isFocused ? "var(--s-7)" : "var(--s-7) 0",
                    borderRadius: isFocused ? "var(--r-chip)" : undefined,
                    background: isFocused ? "color-mix(in oklab, var(--accent) 7%, transparent)" : undefined,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 8,
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: "var(--fw-semibold)", fontSize: "var(--fs-5)" }}>{formatPlanLabel(plan.label, activeVersion?.raw_limits?.credits_multiplier)}</span>
                      <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                        {plan.plan_id}
                      </span>
                      <TextInput
                        value={plan.label}
                        onChange={(v) => patchPlan(group.id, plan.plan_id, { label: v })}
                        placeholder={t("Label", "Etykieta")}
                        width={140}
                        title={t("Plan label", "Etykieta Planu")}
                      />
                      <TextInput
                        value={plan.aliases}
                        onChange={(v) => patchPlan(group.id, plan.plan_id, { aliases: v })}
                        placeholder={t("aliases", "aliasy")}
                        width={160}
                        title={t("Plan aliases", "Aliasy Planu")}
                      />
                    </div>
                    <GhostButton onClick={() => addVersion(group.id, plan.plan_id)}>+ {t("add version", "dodaj wersję")}</GhostButton>
                  </div>
                  <Table tableId="PlanCatalogPanel:0">
                    <thead>
                      <TableRow header>
                        <Th columnId="c0">{t("Effective from", "Od kiedy (from)")}</Th>
                        <Th columnId="c1" align="right">{t("Price $/month", "Cena $/mies")}</Th>
                        <Th columnId="c2" align="right">{t("Annual $/month", "Roczna $/mies")}</Th>
                        <Th columnId="c3">{t("Limits (window / cap)", "Limity (okno / cap)")}</Th>
                        <Th columnId="c4">{t("Source and note", "Źródło i notatka")}</Th>
                        <Th columnId="c5">{t("Default reference (read-only)", "Referencja domyślna (tylko odczyt)")}</Th>
                        <Th columnId="c6" align="right">{t("Action", "Akcja")}</Th>
                      </TableRow>
                    </thead>
                    <tbody>
                      {plan.versions.map((ver, vIdx) => {
                        const usdValid = parseUsd(ver.usd_per_month) !== "invalid";
                        const usdAnnualValid = parseUsd(ver.usd_per_month_annual) !== "invalid";
                        const isUnverified = ver.usd_per_month.trim() === "";
                        const ref = ver.default_reference;
                        const versionId = ver.from.trim() || "origin";
                        const isVersionFocused =
                          Boolean(isFocused) &&
                          Boolean(focusedVersionId) &&
                          (versionId.toLowerCase() === focusedVersionId!.toLowerCase() ||
                            (ver.from.trim() && ver.from.trim().toLowerCase() === focusedVersionId!.toLowerCase()));
                        return (
                          <TableRow
                            key={vIdx}
                            data-version-id={versionId}
                            data-focused-version={isVersionFocused ? "true" : undefined}
                            style={
                              isVersionFocused
                                ? { background: "var(--sunk)", outline: "1px solid var(--accent)" }
                                : undefined
                            }
                          >
                            <Td>
                              <TextInput
                                value={ver.from}
                                onChange={(v) => patchVersion(group.id, plan.plan_id, vIdx, { from: v })}
                                placeholder={t("beginning (origin)", "początek (origin)")}
                                width={120}
                                title={t("Version effective date (YYYY-MM-DD), or empty for the beginning of history", "Data wejścia w życie wersji (YYYY-MM-DD) lub puste dla początku historii")}
                              />
                            </Td>
                            <Td align="right">
                              <TextInput
                                value={ver.usd_per_month}
                                onChange={(v) => patchVersion(group.id, plan.plan_id, vIdx, { usd_per_month: v })}
                                placeholder="—"
                                width={80}
                                align="right"
                                invalid={!usdValid}
                                title={
                                  isUnverified
                                    ? t("price unverified (empty = —)", "cena niezweryfikowana (puste = —)")
                                    : `${usd(Number(ver.usd_per_month))} / ${t("month", "mies")}`
                                }
                              />
                            </Td>
                            <Td align="right">
                              <TextInput
                                value={ver.usd_per_month_annual}
                                onChange={(v) =>
                                  patchVersion(group.id, plan.plan_id, vIdx, { usd_per_month_annual: v })
                                }
                                placeholder="—"
                                width={80}
                                align="right"
                                invalid={!usdAnnualValid}
                                title={t("Optional annual rate $/month", "Opcjonalna stawka roczna $/mies")}
                              />
                            </Td>
                            <Td>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <TextInput
                                  value={ver.window_hours}
                                  onChange={(v) => patchVersion(group.id, plan.plan_id, vIdx, { window_hours: v })}
                                  placeholder={t("window h (for example 5)", "okno h (np. 5)")}
                                  width={85}
                                  title={t("Limit window length in hours", "Długość okna limitu w godzinach")}
                                />
                                <label
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                    fontSize: "var(--fs-3)",
                                    color: "var(--muted)",
                                    cursor: "pointer",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={ver.weekly_cap}
                                    onChange={(e) =>
                                      patchVersion(group.id, plan.plan_id, vIdx, { weekly_cap: e.target.checked })
                                    }
                                  />
                                  <span>{t("weekly cap", "limit tygodniowy")}</span>
                                </label>
                              </div>
                            </Td>
                            <Td>
                              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <TextInput
                                  value={ver.source}
                                  onChange={(v) => patchVersion(group.id, plan.plan_id, vIdx, { source: v })}
                                  placeholder={t("source (URL or description)", "źródło (url lub opis)")}
                                  width={180}
                                  title={t("Source for price and limit information", "Źródło informacji o cenie i limitach")}
                                />
                                <TextInput
                                  value={ver.note}
                                  onChange={(v) => patchVersion(group.id, plan.plan_id, vIdx, { note: v })}
                                  placeholder={t("note", "notatka")}
                                  width={180}
                                  title={t("Additional notes about this version", "Dodatkowe uwagi dotyczące tej wersji")}
                                />
                              </div>
                            </Td>
                            <Td>
                              {ref && "tokens_per_1pct" in ref ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <Pill tone="neutral">{t("release reference (read-only)", "referencja wydania (tylko odczyt)")}</Pill>
                                    {ref.source && (
                                      <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>
                                        {ref.source}
                                      </span>
                                    )}
                                  </div>
                                  <div
                                    className="mono"
                                    style={{ fontSize: "var(--fs-2)", color: "var(--muted)", whiteSpace: "normal" }}
                                  >
                                    in: {compact(ref.tokens_per_1pct.in_uncached)} · cache:{" "}
                                    {compact(ref.tokens_per_1pct.in_cache_read)} · w5m:{" "}
                                    {compact(ref.tokens_per_1pct.in_cache_write_5m)} · out:{" "}
                                    {compact(ref.tokens_per_1pct.out_total)}
                                  </div>
                                </div>
                              ) : ref && "absent" in ref && ref.absent ? (
                                <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                                  — ({reasonLabel(ref.reason) || ref.reason})
                                </span>
                              ) : (
                                <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                                  — ({t("reference missing", "brak referencji")})
                                </span>
                              )}
                            </Td>
                            <Td align="right">
                              {plan.versions.length > 1 && (
                                <GhostButton
                                  onClick={() => removeVersion(group.id, plan.plan_id, vIdx)}
                                  title={t("Remove this version from the catalog", "Usuń tę wersję z katalogu")}
                                >
                                  ×
                                </GhostButton>
                              )}
                            </Td>
                          </TableRow>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}
