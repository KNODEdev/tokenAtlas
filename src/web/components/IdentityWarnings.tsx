import type { IdentityWarning } from "../lib/api";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import { relativeTime } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { Card, Pill, toneColor, type Tone } from "./ui";

export interface IdentityWarningSpec {
  icon: string;
  tone: Tone;
  title: string;
}

/**
 * Presentation per warning kind. The server owns which warnings exist; this map
 * only dresses the ones we already have copy for. A kind that is not listed is
 * rendered with the generic template, so a new server-side kind needs no change
 * here to reach the screen.
 */
const KIND_SPECS: Record<string, Omit<IdentityWarningSpec, "title"> & { en: string; pl: string }> = {
  "account-mismatch": { icon: "⚠", tone: "warn", en: "Vendor account mismatch", pl: "Rozjazd konta vendora" },
};

function humanizeKind(kind: string, t: (en: string, pl: string) => string): string {
  const words = String(kind || "").replace(/[-_]+/g, " ").trim();
  if (!words) return t("Warning", "Ostrzeżenie");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Polish plural: 1 ostrzeżenie, 2–4 ostrzeżenia, 5+ (and the teens) ostrzeżeń. */
function warningCountLabel(n: number, t: (en: string, pl: string) => string): string {
  const last = n % 10;
  const teens = n % 100 >= 12 && n % 100 <= 14;
  if (n === 1) return t("1 warning", "1 ostrzeżenie");
  if (t("warnings", "ostrzeżenia") === "warnings") return `${n} warnings`;
  if (!teens && last >= 2 && last <= 4) return `${n} ostrzeżenia`;
  return `${n} ostrzeżeń`;
}

export function identityWarningSpec(kind: string, t: (en: string, pl: string) => string = translate): IdentityWarningSpec {
  const spec = KIND_SPECS[kind];
  return spec ? { icon: spec.icon, tone: spec.tone, title: t(spec.en, spec.pl) } : { icon: "•", tone: "accent", title: humanizeKind(kind, t) };
}

const TONE_RANK: Record<Tone, number> = { neutral: 0, ok: 1, accent: 2, violet: 3, warn: 4, crit: 5 };

function strongestTone(warnings: IdentityWarning[]): Tone {
  return warnings.reduce<Tone>((worst, w) => {
    const tone = identityWarningSpec(w.kind).tone;
    return TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst;
  }, "neutral");
}

/**
 * Renders every server warning, generically by `kind`. Nothing at all when the
 * list is empty — an "all clear" banner would be noise on every other day.
 */
export function IdentityWarnings({ warnings }: { warnings: IdentityWarning[] }) {
  const { t } = useI18n();
  if (!warnings || warnings.length === 0) return null;
  const border = strongestTone(warnings);
  return (
    <Card
      pad="0"
      style={{
        overflow: "hidden",
        borderColor:
          border === "neutral"
            ? "var(--line)"
            : `color-mix(in oklab, ${toneColor(border)} 35%, transparent)`,
      }}
    >
      <div
        style={{
          padding: "var(--s-7) var(--s-9)",
          borderBottom: "var(--rule)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: "var(--s-4)",
        }}
        data-identity-warnings={warnings.length}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="ui-display" style={{ fontSize: "var(--fs-card-title)" }}>{t("Vendor account identity (Identity)", "Tożsamość kont vendora (Identity)")}</div>
          <Pill tone={border} dot>
            {warningCountLabel(warnings.length, t)}
          </Pill>
        </div>
        <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          {t("declaration is authoritative · probe only shows the mismatch", "deklaracja rządzi · sonda tylko pokazuje rozbieżność")}
        </span>
      </div>
      <div>
        {warnings.map((w, i) => {
          const spec = identityWarningSpec(w.kind, t);
          const sourceLabel = w.subscription_id ? `${t("profile", "profil")} ${w.subscription_id}` : `${t("source", "źródło")} ${w.vendor}`;
          return (
            <div
              key={`${w.kind}:${w.vendor}:${w.source}:${w.ts}:${i}`}
              data-warning-kind={w.kind}
              style={{
                display: "grid",
                gridTemplateColumns: "18px minmax(0, 1fr)",
                gap: "var(--s-5)",
                padding: "var(--s-6) var(--s-9)",
                borderTop: i > 0 ? "var(--rule)" : undefined,
              }}
            >
              <span aria-hidden style={{ fontSize: "var(--fs-5)", color: toneColor(spec.tone), lineHeight: 1.4 }}>
                {spec.icon}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Pill tone={spec.tone} dot>
                    {spec.title}
                  </Pill>
                  <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                    {w.vendor} · {w.subscription_id ?? t("no subscription", "bez subskrypcji")} · {relativeTime(w.ts)}
                  </span>
                </div>
                <div style={{ fontSize: "var(--fs-5)", color: "var(--text)", lineHeight: 1.55, marginTop: "var(--s-3)" }}>
                  {browserSafeDiagnostic(w.hint)}
                </div>
                {(w.observed || w.declared) && (
                  <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: "var(--s-2)" }}>
                    {t("observed", "widziane")}: {browserSafeDiagnostic(w.observed ?? "—")} · {t("declaration", "deklaracja")}: {browserSafeDiagnostic(w.declared ?? "—")}
                  </div>
                )}
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--fs-2)",
                    color: "var(--faint)",
                    marginTop: "var(--s-1)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={sourceLabel}
                >
                  {t("source", "źródło")}: {sourceLabel}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
