import type { PoolView } from "../lib/credit-pools-view";

/** Pool facts have one renderer; compact and inline are placement variants, not provider variants. */
export function PoolFacts({ pool, compact = false }: { pool: PoolView; compact?: boolean }) {
  if (compact) return <div data-pool={pool.key} data-pool-kind={pool.kind}
    title={[pool.title, pool.observedSpend, pool.fundedValue].filter(Boolean).join(" ")}>
    <div className="sub-card-pool-head">
      <span className="sub-card-pool-label">{pool.label}{pool.compactSeparator}<span className="sub-card-pool-amount ui-figure">{pool.compactRemaining}</span></span>
      {pool.aside && <span className="sub-card-pool-aside">{pool.aside}</span>}
    </div>
    {pool.summary && <div className="sub-card-pool-line"><span style={{ whiteSpace: "normal" }}>{pool.summary}</span></div>}
    {pool.bar != null && <span className="sub-card-pool-bar" title={pool.title}>
      <i style={{ width: `${Math.round(pool.bar * 10_000) / 100}%` }} />
    </span>}
  </div>;
  return <span data-pool={pool.key} data-pool-kind={pool.kind} title={pool.title}>
    <b style={{ color: "var(--violet)", fontWeight: "var(--fw-semibold)" }}>{pool.label}</b>{" · "}
    <span className="ui-figure">{pool.summary && <>{pool.summary} · </>}{pool.remaining}</span>
    {pool.aside && <> · {pool.aside}</>}
  </span>;
}
