import { Eyebrow } from "../../components/ui";
import { compact } from "../../lib/format";
import { useI18n } from "../../lib/i18n";

export function Notes({ notes, unpricedTokens }: { notes: string[]; unpricedTokens: number }) {
  const { t } = useI18n();
  return (
    <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)", lineHeight: 1.6 }}>
      {notes.map((n, i) => (
        <div key={i}>· {n}</div>
      ))}
      {unpricedTokens > 0 && (
        <div style={{ color: "var(--warn)" }}>
          · {compact(unpricedTokens)} {t("tokens without a rate in rate-cards.json - counted as tokens and omitted from API-equivalent value.", "tokenów bez stawki w rate-cards.json — policzone w tokenach, pominięte w API-eq.")}
        </div>
      )}
    </div>
  );
}
export function Kpi({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div title={title}>
      <Eyebrow>{label}</Eyebrow>
      <div className="ui-figure" style={{ fontSize: "var(--fs-8)", lineHeight: 1.25, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}
