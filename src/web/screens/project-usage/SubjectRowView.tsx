import type { SubjectRow } from "../../lib/api";
import { subscriptionColor } from "../../components/mix";
import { TableRow, Td } from "../../components/ui";
import { compact, duration, full, pct, usd, workTimeLine } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { formatEquivalentQty } from "../../lib/mixFormat";
import { countLabel, declaredPlanCostHint, hours } from "./format";
import type { MixSlice } from "./model";

export function EstimatedActiveTime({ seconds, idleGap }: { seconds: number; idleGap: number }) {
  const { t } = useI18n();
  const units = workTimeLine(hours(seconds));
  return (
    <span
      title={`${t("Estimated active time at the idle threshold", "Szacowany czas aktywny przy progu bezczynności")} ${idleGap} min${units ? ` · ${units}` : ""}`}
    >
      ≈ {duration(hours(seconds))}{" "}
      <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)", whiteSpace: "nowrap" }}>
        {t("threshold", "próg")} {idleGap}m
      </span>
    </span>
  );
}
export function SubjectRowView({
  row,
  active,
  picked,
  maxApi,
  billed,
  billedComplete = true,
  apiUsd,
  mix,
  sharePct,
  nameOf = id => id,
  idleGap,
  onClick,
  onPick,
}: {
  row: SubjectRow;
  active: boolean;
  picked: boolean;
  maxApi: number;
  billed: number | null;
  billedComplete?: boolean;
  apiUsd: number | null;
  mix: MixSlice[] | null;
  sharePct: number | null;
  nameOf?: (id: string) => string;
  idleGap: number;
  onClick: () => void;
  onPick: () => void;
}) {
  const { t } = useI18n();
  const slices = [...(mix ?? [])].filter((s) => s.api > 0).sort((a, b) => b.api - a.api);
  const mixTitle = (mix ?? [])
    .map((s) =>
      `${nameOf(s.id)}${s.plan ? ` · ${s.plan}` : ""}: API-eq ${usd(s.api)} · ${t("plan-cost share", "udział w koszcie")} ${usd(s.billed)}` +
      ` · ${formatEquivalentQty(s.weekly)} ${t("weekly subs.", "tyg. ab.")} · ${formatEquivalentQty(s.monthly)} ${t("monthly subs.", "mies. ab.")}`)
    .join("\n");
  const width = apiUsd != null && maxApi > 0 ? Math.max(1, Math.min(100, (apiUsd / maxApi) * 100)) : 0;
  return (
    <TableRow onClick={onClick} className={`projects-row${active ? " is-active" : ""}`}>
      <Td>
        <input
          type="checkbox"
          checked={picked}
          onChange={onPick}
          onClick={(e) => e.stopPropagation()}
          aria-label={t("Select {0} to merge", `Zaznacz ${row.name} do scalenia`, [row.name])}
          style={{ accentColor: "var(--accent)", cursor: "pointer" }}
        />
      </Td>
      <Td style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={row.name}>
        <div className="projects-name">
          <span>{row.name}</span>
          {row.kind === "repo" && <span className="projects-badge" title={t("A directory without a project; assign it in the Unassigned tab.", "Katalog bez projektu; przypiszesz go w zakładce Nieprzypisane.")}>{t("repo without a project", "repo bez projektu")}</span>}
        </div>
        <div className="projects-sub" title={row.kind === "project" && row.repos.length > 0 ? row.repos.join(" + ") : undefined}>
          {row.kind === "project" && row.repos.length > 0 ? row.repos.join(" + ") : row.group ?? "—"}
        </div>
      </Td>
      <Td>
        <div className="projects-api" title={mixTitle || undefined}>
          <div className="projects-bar" style={{ width: `${width}%` }}>
            {slices.length > 0
              ? slices.map((s) => <span key={s.id} data-legend-sub={s.id} style={{ flexGrow: s.api, background: subscriptionColor(s.id) }} />)
              : width > 0 && <span style={{ flexGrow: 1, background: "var(--accent)" }} />}
          </div>
          <span className="mono">{apiUsd == null ? "—" : usd(apiUsd)}</span>
        </div>
      </Td>
      <Td align="right" mono title={`${full(row.tokens)} ${countLabel(t, row.tokens, "token", "tokens", "token", "tokeny", "tokenów")} · ${full(row.calls)} ${countLabel(t, row.calls, "call", "calls", "wywołanie", "wywołania", "wywołań")}`}>
        {compact(row.tokens)}
      </Td>
      <Td align="right">
        <EstimatedActiveTime seconds={row.active_seconds} idleGap={idleGap} />
      </Td>
      <Td align="right" mono>
        <div
          data-billed-unavailable={billed == null && billedComplete === false ? "" : undefined}
          data-billed-incomplete={billed != null && billedComplete === false ? "" : undefined}
          title={
            billed == null
              ? billedComplete === false
                ? t("share unavailable - no subscription has a declared price", "udział niedostępny — żaden abonament nie ma zadeklarowanej ceny")
                : undefined
              : `${declaredPlanCostHint(t)}${billedComplete === false ? `\n${t("incomplete: sum of known subscriptions", "niepełne: suma znanych abonamentów")}` : ""}`
          }
        >
          {billed == null ? "—" : usd(billed)}
          {sharePct != null && <span className="projects-faint"> · {pct(sharePct, 1)}</span>}
        </div>
        {billed != null && billedComplete === false && <div className="projects-incomplete">{t("incomplete", "niepełne")}</div>}
      </Td>
    </TableRow>
  );
}
