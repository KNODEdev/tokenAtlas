import type { CycleTokens } from "./api";
import type { CycleView } from "./cycle";
import type { RosterCard } from "./roster";
import { getLocale, translate } from "./i18n";
import { pointBasisOfCycles, pointBasisTitle } from "./current-point-basis";
export const MIN_PP_FOR_RATE = 20;
const MIN_GAUGE_SAMPLES = 20;
const MIN_CALLS = 100;
function localizedNumber(value: number, fractionDigits = 0): string {
  return value
    .toLocaleString(getLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
    .replace(/\u00a0/g, " ");
}
export function usdPerPoint(c: CycleView): number | null {
  if (c.raw.point_basis !== undefined) return c.raw.point_basis ? c.raw.point_basis.usd / 100 : null;
  if (c.usedPercent < MIN_PP_FOR_RATE) return null;
  if (c.raw.sample_count < MIN_GAUGE_SAMPLES) return null;
  if (c.calls < MIN_CALLS) return null;
  const fromApi = c.raw.usd_per_percent;
  if (fromApi != null && Number.isFinite(fromApi) && fromApi > 0) return fromApi;
  if (c.usd > 0) return c.usd / c.usedPercent;
  return null;
}
function median(xs: number[]): number | null {
  const v = [...xs].sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid] ?? null;
  const lo = v[mid - 1];
  const hi = v[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}
export interface TokenMix {
  inFresh: number;
  cachedIn: number;
  cacheWrite: number;
  out: number;
  reasoning: number;
}
export interface PlanValue {
  id: string;
  plan: string | null;
  color: string;
  group: string;
  windows: number;
  rate: number | null;
  best: { rate: number; label: string } | null;
  worst: { rate: number; label: string } | null;
  windowValue: number | null;
  tokensPerWindow: number | null;
  tokens: TokenMix | null;
  basis: "measured" | "single" | "none";
  note: string;
}
function mixOf(all: CycleTokens[], medianTotal: number | null): TokenMix | null {
  if (all.length === 0 || medianTotal == null || medianTotal <= 0) return null;
  const acc = all.reduce(
    (a, t) => ({
      inFresh: a.inFresh + Math.max(0, t.in - t.cached_in),
      cachedIn: a.cachedIn + t.cached_in,
      cacheWrite: a.cacheWrite + t.cache_write,
      out: a.out + t.out,
      reasoning: a.reasoning + t.reasoning,
    }),
    { inFresh: 0, cachedIn: 0, cacheWrite: 0, out: 0, reasoning: 0 }
  );
  const total = acc.inFresh + acc.cachedIn + acc.cacheWrite + acc.out;
  if (total <= 0) return null;
  const k = medianTotal / total;
  return {
    inFresh: acc.inFresh * k,
    cachedIn: acc.cachedIn * k,
    cacheWrite: acc.cacheWrite * k,
    out: acc.out * k,
    reasoning: acc.reasoning * k,
  };
}
function scaleMix(mix: TokenMix, k: number): TokenMix {
  if (!Number.isFinite(k) || k <= 0) return mix;
  return {
    inFresh: mix.inFresh * k,
    cachedIn: mix.cachedIn * k,
    cacheWrite: mix.cacheWrite * k,
    out: mix.out * k,
    reasoning: mix.reasoning * k,
  };
}
export function planValue(card: RosterCard): PlanValue {
  const base = {
    id: card.id,
    plan: card.plan,
    color: card.color,
    group: card.group,
  };
  if (card.group === "codex") {
    const cycles = card.model?.cycles ?? [];
    const basis = card.pointBasis === undefined ? pointBasisOfCycles(cycles) : card.pointBasis;
    const source = basis && cycles.find(cycle => Date.parse(cycle.startIso) === Date.parse(basis.windowStart));
    const history = cycles.map(cycle => ({ rate: usdPerPoint(cycle), label: cycle.label }))
      .filter((row): row is { rate: number; label: string } => row.rate !== null).sort((a, b) => a.rate - b.rate);
    return { ...base, windows: basis ? 1 : 0, rate: basis ? basis.usd / 100 : null,
      best: history.at(-1) ?? null, worst: history[0] ?? null, windowValue: basis?.usd ?? null, tokensPerWindow: basis?.tokens ?? null,
      tokens: source && basis ? mixOf([source.raw.tokens], basis.tokens) : null,
      basis: basis ? "single" : "none", note: pointBasisTitle(basis) };
  }
  const recent = card.model?.typical ?? [];
  const closed = recent.length > 0 ? recent : card.model?.closed ?? [];
  if (closed.length > 0) {
    const rated = closed
      .map((c) => ({ c, rate: usdPerPoint(c) }))
      .filter((r): r is { c: CycleView; rate: number } => r.rate != null);
    if (rated.length > 0) {
      const rates = rated.map((r) => r.rate);
      const med = median(rates);
      const sorted = [...rated].sort((a, b) => a.rate - b.rate);
      const medianTokens = median(rated.map((r) => r.c.tokensTotal));
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      return {
        ...base,
        windows: rated.length,
        rate: med,
        best: hi ? { rate: hi.rate, label: hi.c.label } : null,
        worst: lo ? { rate: lo.rate, label: lo.c.label } : null,
        windowValue: med != null ? med * 100 : null,
        tokensPerWindow: medianTokens,
        tokens: mixOf(rated.map((r) => r.c.raw.tokens), medianTokens),
        basis: "measured",
        note: translate(
          "Median from {0} of {1} latest windows. The rest do not meet the coverage thresholds ({2} pp, {3} gauge samples, {4} calls)",
          `Mediana z ${localizedNumber(rated.length)} z ${localizedNumber(closed.length)} ostatnich okien — reszta nie spełnia progów pokrycia (${localizedNumber(MIN_PP_FOR_RATE)} pp, ${localizedNumber(MIN_GAUGE_SAMPLES)} próbek gauge, ${localizedNumber(MIN_CALLS)} wywołań)`, [localizedNumber(rated.length), localizedNumber(closed.length), localizedNumber(MIN_PP_FOR_RATE), localizedNumber(MIN_GAUGE_SAMPLES), localizedNumber(MIN_CALLS)],
        ),
      };
    }
  }
  const active = card.model?.current ?? null;
  if (active) {
    const r = usdPerPoint(active);
    if (r != null) {
      const scale = 100 / active.usedPercent;
      return {
        ...base,
        windows: 1,
        rate: r,
        best: null,
        worst: null,
        windowValue: r * 100,
        tokensPerWindow: active.tokensTotal * scale,
        tokens: mixOf([active.raw.tokens], active.tokensTotal * scale),
        basis: "single",
        note: translate(
          "One indexed window ({0}, {1}% used). No distribution",
          `Jedno okno w indeksie (${active.label}, ${localizedNumber(active.usedPercent)}% zużycia) — bez rozkładu`, [active.label, localizedNumber(active.usedPercent)],
        ),
      };
    }
  }
  if (card.claude?.usd_per_point != null) {
    const r = card.claude.usd_per_point;
    const claudeWindow = card.claude.current;
    const claudePercent = claudeWindow?.percent_all_measured ?? claudeWindow?.percent_all_est ?? null;
    return {
      ...base,
      windows: 0,
      rate: r,
      best: null,
      worst: null,
      windowValue: card.claude.window_value_usd ?? r * 100,
      tokensPerWindow:
        claudeWindow != null && claudePercent != null && claudePercent > 0
          ? (claudeWindow.spend.gross * 100) / claudePercent
          : null,
      tokens: null,
      basis: "single",
      note: translate(
        "Calibration from the account reading (claude-gauge.json) - one value, no distribution",
        "Kalibracja z odczytu konta (claude-gauge.json) — jedna liczba, bez rozkładu",
      ),
    };
  }
  const grokRate = card.grok?.limit?.calibration?.usd_per_point ?? null;
  if (grokRate != null) {
    return {
      ...base,
      windows: 0,
      rate: grokRate,
      best: null,
      worst: null,
      windowValue: grokRate * 100,
      tokensPerWindow:
        card.usedPercent != null && card.usedPercent > 0 && card.tokensTotal != null
          ? (card.tokensTotal * 100) / card.usedPercent
          : card.tokensTotal,
      tokens:
        card.grok != null
          ? scaleMix(
              {
                inFresh: card.grok.spend.fresh,
                cachedIn: card.grok.spend.cached,
                cacheWrite: 0,
                out: card.grok.spend.out,
                reasoning: card.grok.spend.reasoning,
              },
              card.usedPercent != null && card.usedPercent > 0 ? 100 / card.usedPercent : 1
            )
          : null,
      basis: "single",
      note: translate(
        "Scale from grok-gauge.json - the vendor does not publish a counter",
        "Skala z grok-gauge.json — vendor nie publikuje licznika",
      ),
    };
  }
  const glmWindow = card.glm?.windows.find((w) => w.kind === card.glm?.headline_kind) ?? card.glm?.windows[0] ?? null;
  if (glmWindow?.spend && glmWindow.percent >= MIN_PP_FOR_RATE) {
    const r = glmWindow.spend.usd / glmWindow.percent;
    return {
      ...base,
      windows: 0,
      rate: r,
      best: null,
      worst: null,
      windowValue: r * 100,
      tokensPerWindow: (glmWindow.spend.gross * 100) / glmWindow.percent,
      tokens: scaleMix(
        {
          inFresh: glmWindow.spend.in_tok - glmWindow.spend.cache_read,
          cachedIn: glmWindow.spend.cache_read,
          cacheWrite: 0,
          out: glmWindow.spend.out_tok,
          reasoning: glmWindow.spend.reasoning,
        },
        100 / glmWindow.percent
      ),
      basis: "single",
      note: translate(
        "Current window {0} - credits from the account, dollars from the z.ai price list",
        `Bieżące okno ${glmWindow.label} — kredyty z konta, dolary z cennika z.ai`, [glmWindow.label],
      ),
    };
  }
  return {
    ...base,
    windows: 0,
    rate: null,
    best: null,
    worst: null,
    windowValue: null,
    tokensPerWindow: card.tokensTotal,
    tokens: null,
    basis: "none",
    note:
      card.group === "gemini"
        ? translate(
            "Antigravity provides a limit counter but no cost - there is no basis for calculating the point rate",
            "Antigravity podaje licznik limitu, ale żadnego kosztu — kursu punktu nie ma z czego policzyć",
          )
        : translate("no closed window above the threshold", "brak zamkniętego okna powyżej progu"),
  };
}
