import { TableGrid, TableGridRow } from "./DataTable";
import type { CSSProperties } from "react";
import type { AtlasModel, CycleView } from "../lib/cycle";
import { compact, pct, signedPct, signedPp, usd } from "../lib/format";
import { useI18n, type MessageTranslator } from "../lib/i18n";
import { Card, CardTitle, Eyebrow } from "./ui";
interface ValueRow {
  cycle: CycleView;
  tokensPerPercent: number | null;
  usdPerPercent: number | null;
  cacheRate: number | null;
}
function medianOf(xs: (number | null)[]): number | null {
  const v = xs.filter((n): n is number => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid] ?? null;
  const lo = v[mid - 1];
  const hi = v[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}
export function cacheRateOf(c: CycleView): number | null {
  const t = c.raw.tokens;
  return t.in > 0 ? (t.cached_in / t.in) * 100 : null;
}
function rowOf(c: CycleView): ValueRow {
  return {
    cycle: c,
    tokensPerPercent: c.usedPercent > 0 ? c.tokensTotal / c.usedPercent : null,
    usdPerPercent: c.raw.usd_per_percent,
    cacheRate: cacheRateOf(c),
  };
}
export function AllowanceValue({ model, limit = 10 }: { model: AtlasModel; limit?: number }) {
  const { language, t } = useI18n();
  const closed = model.typical.slice(0, limit).map(rowOf);
  const current = model.current ? rowOf(model.current) : null;
  const rows = current ? [current, ...closed] : closed;
  const medTokens = medianOf(closed.map((r) => r.tokensPerPercent));
  const medUsd = medianOf(closed.map((r) => r.usdPerPercent));
  const medCache = medianOf(closed.map((r) => r.cacheRate));
  const maxTokens = Math.max(1, ...rows.map((r) => r.tokensPerPercent ?? 0));
  const maxUsd = Math.max(0.01, ...rows.map((r) => r.usdPerPercent ?? 0));
  const latest = closed[0] ?? null;
  const dTokens =
    latest?.tokensPerPercent != null && medTokens ? (latest.tokensPerPercent / medTokens - 1) * 100 : null;
  const dUsd = latest?.usdPerPercent != null && medUsd ? (latest.usdPerPercent / medUsd - 1) * 100 : null;
  const dCache = latest?.cacheRate != null && medCache != null ? latest.cacheRate - medCache : null;
  const verdict = diagnose(dTokens, dUsd, dCache, t);
  const COLS = "38px minmax(0,1fr) 62px minmax(0,1fr) 56px 48px";
  return (
    <Card>
      <CardTitle
        title={t("Observed reference value at 1% allowance", "Obserwowana wartość referencyjna 1% limitu")}
        help={t("Related reference measures for each window; interpretation depends on model mix and data coverage.", "Powiązane miary referencyjne dla każdego okna; interpretacja zależy od miksu modeli i kompletności danych.")}
        right={
          <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
            {t("median of", "mediana z")} {closed.length} {t("closed windows", "zamkniętych okien")}
          </span>
        }
      />
      <div className="ui-kpi-strip" style={{ "--kpi-columns": 3, marginTop: "var(--s-5)" } as CSSProperties}>
        <Tile
          label={t("tokens / 1%", "tokeny / 1%")}
          value={medTokens != null ? compact(medTokens) : "—"}
          delta={dTokens}
          hint={t("Median gauge calibration. It depends on model mix and cache, not only on the quota.", "Mediana z kalibracji gauge'a. Zależy od miksu modeli i cache'u, nie tylko od limitu.")}
        />
        <Tile
          label={t("$ / 1%", "$ / 1%")}
          value={medUsd != null ? usd(medUsd) : "—"}
          delta={dUsd}
          hint={t("Median API-equivalent estimate per percentage point. It is a reference value for observed traffic and depends on model mix, prices, Speed, and data coverage.", "Mediana wyceny API-eq na punkt procentowy. To miara referencyjna obserwowanego ruchu; zależy od miksu modeli, cen, trybu Speed i kompletności danych.")}
        />
        <Tile
          label={t("cache rate", "udział cache")}
          value={medCache != null ? pct(medCache, 1) : "—"}
          delta={dCache}
          deltaUnit="pp"
          hint={t("Cache reads as a share of input (cached_in / in_tok). High cache fills the token column without proving a change in window value.", "Odczyty z cache jako udział inputu (cached_in / in_tok). Wysoki cache napełnia kolumnę tokenów, ale sam nie dowodzi zmiany wartości okna.")}
        />
      </div>
      <div
        style={{
          marginTop: "var(--s-5)",
          padding: "var(--s-4) var(--s-6)",
          borderRadius: "var(--r-chip)",
          background: verdict.tone === "var(--text)" ? "var(--sunk)" : `color-mix(in oklab, ${verdict.tone} 12%, transparent)`,
          fontSize: "var(--fs-4)",
          color: "var(--text)",
          lineHeight: 1.5,
        }}
      >
        <span style={{ color: verdict.tone, fontWeight: "var(--fw-semibold)" }}>
          {verdict.title}
        </span>
        <span style={{ color: "var(--muted)" }}>{language === "pl" ? " — " : " - "}{verdict.body}</span>
      </div>
      {rows.length > 0 && (
        <TableGrid tableId="AllowanceValue:history"><>
          <TableGridRow header
            style={{
              marginTop: "var(--s-6)",
              display: "grid",
              gridTemplateColumns: COLS,
              gap: "var(--s-4)",
              padding: "0 var(--s-1) var(--s-3)",
              borderBottom: "1px solid var(--line2)",
              fontSize: "var(--fs-3)",
              color: "var(--muted)",
            }}
          >
            <span>{t("window", "okno")}</span>
            <span>{t("tokens / 1%", "tokeny / 1%")}</span>
            <span data-column-label={t("Tokens per 1% · value", "Tokeny na 1% · wartość")} style={{ textAlign: "right" }}>{t("value", "wartość")}</span>
            <span>$ / 1%</span>
            <span data-column-label={t("API per 1% · value", "API na 1% · wartość")} style={{ textAlign: "right" }}>{t("value", "wartość")}</span>
            <span style={{ textAlign: "right" }}>{t("cache", "cache")}</span>
          </TableGridRow>
          {rows.map((r) => (
            <TableGridRow
              key={r.cycle.index}
              className="mono"
              title={`${r.cycle.label} · ${r.cycle.dateLabel} · ${pct(r.cycle.usedPercent)} allowance${
                r.cycle.isActive ? ` · ${t("window is active; both references are still unstable", "okno trwa, obie miary referencyjne są jeszcze niestabilne")}` : ""
              }`}
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: "var(--s-4)",
                alignItems: "center",
                padding: "var(--s-3) var(--s-1)",
                borderBottom: "var(--rule)",
                opacity: r.cycle.isActive ? 0.75 : 1,
              }}
            >
              <span style={{ fontSize: "var(--fs-3)", color: r.cycle.isActive ? "var(--accent)" : "var(--muted)" }}>
                #{r.cycle.number}
              </span>
              <MiniBar value={r.tokensPerPercent} max={maxTokens} color="var(--violet)" reference={medTokens} />
              <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)", textAlign: "right", color: "var(--muted)" }}>
                {r.tokensPerPercent != null ? compact(r.tokensPerPercent) : "—"}
              </span>
              <MiniBar value={r.usdPerPercent} max={maxUsd} color="var(--ok)" reference={medUsd} />
              <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)", textAlign: "right", color: "var(--muted)" }}>
                {r.usdPerPercent != null ? usd(r.usdPerPercent) : "—"}
              </span>
              <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)", textAlign: "right", color: "var(--faint)" }}>
                {r.cacheRate != null ? pct(r.cacheRate, 0) : "—"}
              </span>
            </TableGridRow>
          ))}
        </></TableGrid>
      )}
      <div className="mono" style={{ marginTop: "var(--s-4)", fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
        {t("The line on each bar is the median. The $/1% reference comes from the server and is not extrapolated below 20% window usage - short cycles stay blank instead of being guessed.", "Kreska na paskach to mediana. Referencja $/1% pochodzi z serwera i nie jest ekstrapolowana poniżej 20% zużycia okna — krótkie cykle zostawiają puste pole zamiast zgadywać.")}
      </div>
    </Card>
  );
}
function diagnose(
  dTokens: number | null,
  dUsd: number | null,
  dCache: number | null,
  t: MessageTranslator,
): { title: string; body: string; tone: string } {
  const cacheMagnitude = dCache == null ? null : pct(Math.abs(dCache)).replace(/%$/, "");
  if (dTokens == null && dUsd == null) {
    return {
      title: t("No reference", "Brak odniesienia"),
      body: t("There are too few closed calibrated windows to interpret a change in reference value.", "Za mało zamkniętych okien z kalibracją, żeby interpretować zmianę wartości referencyjnej."),
      tone: "var(--faint)",
    };
  }
  const bigUsd = dUsd != null && Math.abs(dUsd) > 10;
  const bigTokens = dTokens != null && Math.abs(dTokens) > 10;
  if (bigUsd && bigTokens && dUsd != null && dTokens != null && Math.sign(dUsd) === Math.sign(dTokens)) {
    const down = dUsd < 0;
    return {
      title: t("Both references moved", "Obie miary się przesunęły"),
      body: t(
        "Both reference measures moved in the same direction ({0} tokens, {1} value). This does not establish a provider quota change: model mix, Fast usage, pricing, and data completeness remain possible confounders.",
        `Obie miary referencyjne przesunęły się w tę samą stronę (${signedPct(dTokens)} tokenów, ${signedPct(dUsd)} wartości). To nie dowodzi zmiany limitu u dostawcy: możliwymi czynnikami pozostają miks modeli, użycie Fast, ceny i kompletność danych.`, [signedPct(dTokens), signedPct(dUsd)],
      ),
      tone: down ? "var(--crit)" : "var(--ok)",
    };
  }
  if (bigTokens && !bigUsd) {
    return {
      title: t("Token volume changed more than reference value", "Wolumen tokenów zmienił się bardziej niż wartość referencyjna"),
      body: t(
        "Tokens per 1% changed by {0}, while the reference value moved by {1}{2}. This is compatible with a changed model mix; it does not establish that the provider quota stayed the same.",
        `Tokenów na 1% zmieniło się o ${signedPct(dTokens)}, a wartość referencyjna o ${signedPct(dUsd)}${cacheMagnitude != null ? ` — cache ${dCache! > 0 ? "wyżej" : "niżej"} o ${cacheMagnitude} pp` : ""}. To jest zgodne ze zmianą miksu modeli; nie dowodzi, że limit dostawcy pozostał bez zmian.`, [signedPct(dTokens), signedPct(dUsd), cacheMagnitude != null ? ` - cache ${dCache! > 0 ? "higher" : "lower"} by ${cacheMagnitude} pp` : ""],
      ),
      tone: "var(--violet)",
    };
  }
  if (bigUsd && !bigTokens) {
    const down = dUsd != null && dUsd < 0;
    return {
       title: t("Reference value changed at similar token volume", "Wartość referencyjna zmieniła się przy podobnym wolumenie tokenów"),
       body: t("The 1% reference value changed by {0} while token volume stayed similar. Model mix, prices, Speed, and coverage can explain this; it does not establish a quota change.", `Wartość referencyjna 1% zmieniła się o ${signedPct(dUsd)}, a wolumen tokenów pozostał podobny. Mogą to wyjaśniać miks modeli, ceny, tryb Speed i kompletność; nie dowodzi to zmiany limitu.`, [signedPct(dUsd)]),
      tone: down ? "var(--ok)" : "var(--warn)",
    };
  }
  return {
    title: t("Window reference value is stable", "Wartość referencyjna okna stabilna"),
    body: t("The latest closed window remains near the median ({0} tokens, {1} value); this is an observed comparison, not a provider quota verdict.", `Ostatnie zamknięte okno trzyma się mediany (${signedPct(dTokens)} tokenów, ${signedPct(dUsd)} wartości); to obserwowane porównanie, a nie werdykt o limicie dostawcy.`, [signedPct(dTokens), signedPct(dUsd)]),
    tone: "var(--text)",
  };
}
function Tile({
  label,
  value,
  delta,
  deltaUnit = "%",
  hint,
}: {
  label: string;
  value: string;
  delta: number | null;
  deltaUnit?: "%" | "pp";
  hint: string;
}) {
  const { t } = useI18n();
  const tone = delta == null ? "var(--faint)" : Math.abs(delta) < (deltaUnit === "pp" ? 3 : 10) ? "var(--muted)" : delta < 0 ? "var(--crit)" : "var(--warn)";
  return (
    <div className="ui-kpi-cell" title={hint}>
      <Eyebrow>{label}</Eyebrow>
      <div className="ui-figure" style={{ fontSize: "var(--fs-7)", marginTop: "var(--s-1)" }}>
        {value}
      </div>
      <div className="mono" style={{ fontSize: "var(--fs-3)", color: tone }}>
        {delta == null
           ? t("no reference", "brak odniesienia")
            : `${deltaUnit === "pp" ? signedPp(delta) : signedPct(delta)} ${t("latest vs median", "ostatnie vs mediana")}`}
      </div>
    </div>
  );
}
function MiniBar({
  value,
  max,
  color,
  reference,
}: {
  value: number | null;
  max: number;
  color: string;
  reference: number | null;
}) {
  return (
    <span
      style={{
        position: "relative",
        display: "block",
        height: 7,
        boxSizing: "border-box",
        background: "var(--sunk)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-bar)",
        overflow: "hidden",
      }}
    >
      {value != null && (
        <span
          style={{
            position: "absolute",
            inset: `0 ${100 - Math.min(100, (value / max) * 100)}% 0 0`,
            background: color,
            display: "block",
          }}
        />
      )}
      {reference != null && (
        <span
          style={{
            position: "absolute",
            left: `${Math.min(100, (reference / max) * 100)}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: "var(--text)",
            opacity: 0.55,
            display: "block",
          }}
        />
      )}
    </span>
  );
}
