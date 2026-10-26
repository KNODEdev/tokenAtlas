import { useI18n } from "../../lib/i18n";
import type { ProjectMixModel } from "./mix-chart-model";

export function ProjectMixPlot({ plot, hoverIdx, onHover, colorOf }: {
  plot: ProjectMixModel["plot"];
  hoverIdx: number | null;
  onHover: (index: number | null) => void;
  colorOf: (id: string) => string;
}) {
  const { t } = useI18n();
  const { pctMode, W, H, padTop, plotH, limitY, linePts, timeDots, buckets } = plot;
  return (
    <div style={{ position: "relative" }}>
      {pctMode && (
        <span
          data-limit-label=""
          className="mono"
          style={{ position: "absolute", right: 0, top: `${(limitY / H) * 100}%`, transform: "translateY(-120%)", fontSize: "var(--fs-1)", color: "var(--muted)", pointerEvents: "none" }}
        >
          {t("limit", "limit")} 100%
        </span>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 180, display: "block", overflow: "visible" }}
        onMouseLeave={() => onHover(null)}
      >
        <defs>
          <pattern
            id="mix-billed-incomplete"
            patternUnits="userSpaceOnUse"
            width="2.4"
            height="2.4"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="2.4" stroke="var(--warn)" strokeWidth="0.7" opacity="0.85" />
          </pattern>
          {/* "No data" for a vendor: a quiet, sparse dot texture, so it reads as absence, not as a value. */}
          <pattern id="mix-uncovered" patternUnits="userSpaceOnUse" width="6" height="6">
            <circle cx="1.5" cy="1.5" r="0.6" fill="var(--line2)" opacity="0.7" />
          </pattern>
        </defs>
        {[0, 0.5, 1].map((pct) => {
          const y = padTop + plotH * (1 - pct);
          return (
            <line
              key={pct}
              x1={0}
              x2={W}
              y1={y}
              y2={y}
              stroke="var(--line)"
              strokeWidth={1}
              strokeDasharray={pct > 0 ? "3 4" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {pctMode && (
          <line
            data-limit-line=""
            x1={0}
            x2={W}
            y1={limitY}
            y2={limitY}
            stroke="var(--muted)"
            strokeWidth={1}
            strokeDasharray="5 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {buckets.map(({ point: p, index: i, x, barW, bars, incomplete, uncovered, tooltip, hasStack, incompleteRect }) => {
          const isHovered = hoverIdx === i;
          return (
            <g
              key={p.bucket}
              data-pct-bucket={pctMode ? p.bucket : undefined}
              data-billed-incomplete={!pctMode && incomplete ? "" : undefined}
              data-uncovered={uncovered.length > 0 ? "" : undefined}
              data-uncovered-subs={!pctMode && uncovered.length > 0 ? uncovered.join(" ") : undefined}
              onMouseEnter={() => onHover(i)}
              style={{ cursor: "pointer", opacity: hoverIdx == null || isHovered ? 1 : 0.55 }}
            >
              <title>{tooltip}</title>
              {bars.map((bar) => pctMode ? (
                <rect
                  key={bar.id}
                  data-sub={bar.id!}
                  data-pct={bar.pct!.toFixed(1)}
                  data-single={bar.single ? "" : undefined}
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  fill={colorOf(bar.id!)}
                  fillOpacity={bar.single ? 0.45 : 1}
                  stroke={bar.single ? colorOf(bar.id!) : "var(--surface)"}
                  strokeWidth={1}
                  strokeDasharray={bar.single ? "2 1.5" : undefined}
                  vectorEffect="non-scaling-stroke"
                  rx={0.3}
                />
              ) : (
                <rect
                  key={bar.id ?? "total"}
                  data-sub={bar.id ?? undefined}
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  fill={bar.id == null ? "var(--accent)" : colorOf(bar.id)}
                  stroke="var(--surface)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  rx={0.3}
                />
              ))}
              {incompleteRect && (
                <rect
                  data-billed-incomplete=""
                  x={x}
                  y={incompleteRect.y}
                  width={barW}
                  height={incompleteRect.height}
                  fill="none"
                  stroke="var(--warn)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="4 3"
                  pointerEvents="none"
                />
              )}
              {/* Absence remains distinct from a measured zero and never textures an existing bar. */}
              {uncovered.length > 0 && !hasStack && (
                <rect
                  data-uncovered=""
                  x={x}
                  y={padTop}
                  width={barW}
                  height={plotH}
                  fill="url(#mix-uncovered)"
                  stroke="var(--faint)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="2 3"
                  pointerEvents="none"
                />
              )}
            </g>
          );
        })}
        {timeDots.length > 1 && (
          <polyline
            points={linePts}
            fill="none"
            stroke="var(--warn)"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            opacity={0.95}
          />
        )}
        {timeDots.map(({ bucket, cx, cy }, i) => {
          const isHovered = hoverIdx === i;
          const d = timeDots.length === 1 ? 6 : isHovered ? 5 : 3;
          // Non-scaling, round-capped lines stay round when the SVG stretches horizontally.
          return (
            <g key={bucket} opacity={0.95}>
              <line x1={cx} y1={cy} x2={cx} y2={cy} stroke="var(--surface)" strokeWidth={d + 2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              <line x1={cx} y1={cy} x2={cx} y2={cy} stroke="var(--warn)" strokeWidth={d} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
