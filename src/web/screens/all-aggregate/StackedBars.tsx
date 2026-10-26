import type { AccountHistoryPoint } from "../../lib/api";
import { apiEq, bucketLabel } from "./format";

export function StackedBars({
  points,
  accounts,
  group,
  money,
  fmt,
  avg,
  labels,
}: {
  points: AccountHistoryPoint[];
  accounts: Array<{ id: string; label: string; color: string }>;
  group: string;
  money: boolean;
  fmt: (v: number) => string;
  avg?: number;
  /** Value texts above single bars, by period index. */
  labels?: Map<number, string>;
}) {
  const H = 210;
  const labelRoom = labels?.size ? 16 : 0;
  const max = Math.max(...points.map((p) => (money ? p.usd ?? p.priced_usd ?? 0 : p.tokens)), 1);
  const every = Math.max(1, Math.ceil(points.length / 16));
  return (
    <div style={{ overflowX: "auto", paddingTop: 12 }}>
      <div style={{ position: "relative", minWidth: points.length * 26 }}>
        {avg != null && avg > 0 && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 26 + (avg / max) * H,
              borderTop: "1px dashed color-mix(in oklab, var(--accent) 55%, transparent)",
              pointerEvents: "none",
            }}
          />
        )}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: H + 26 + labelRoom }}>
          {points.map((p, i) => {
            const totalHere = money ? p.usd ?? p.priced_usd ?? 0 : p.tokens;
            const h = Math.max(2, Math.round((totalHere / max) * H));
            return (
              <div
                key={p.bucket}
                style={{ flex: "1 1 0", minWidth: 20, display: "flex", flexDirection: "column", alignItems: "center" }}
                title={`${bucketLabel(p.bucket, group)} · ${money ? apiEq(p) : fmt(totalHere)}`}
              >
                {labels?.has(i) && (
                  <div className="mono" style={{ fontSize: "var(--fs-2)", fontWeight: 500, fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", marginBottom: 3, whiteSpace: "nowrap" }}>{labels.get(i)}</div>
                )}
                <div
                  style={{
                    width: "100%",
                    height: h,
                    display: "flex",
                    flexDirection: "column-reverse",
                    borderRadius: "var(--r-bar)",
                    overflow: "hidden",
                  }}
                >
                  {accounts.map((a) => {
                    const slice = p.split[a.id];
                    if (!slice) return null;
                    const v = money ? slice.usd ?? slice.priced_usd ?? 0 : slice.tokens;
                    if (v <= 0) return null;
                    return (
                      <div
                        key={a.id}
                        style={{ height: `${(v / totalHere) * 100}%`, background: a.color }}
                        title={`${a.label} · ${money ? apiEq(slice) : fmt(v)}`}
                      />
                    );
                  })}
                </div>
                <div className="mono" style={{ fontSize: "var(--fs-1)", fontFamily: "var(--font-figure)", color: "var(--muted)", marginTop: 5, whiteSpace: "nowrap" }}>
                  {i % every === 0 ? bucketLabel(p.bucket, group) : ""}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export function Legend({ accounts }: { accounts: Array<{ id: string; label: string; color: string }> }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12 }}>
      {accounts.map((a) => (
        <span key={a.id} className="mono" style={{ fontSize: "var(--fs-3)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: a.color }} />
          {a.label}
        </span>
      ))}
    </div>
  );
}
