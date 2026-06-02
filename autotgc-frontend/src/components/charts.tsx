/**
 * Dependency-free chart primitives (pure SVG/CSS) for the analytics pages.
 * Kept intentionally small and consistent with the app's plain-CSS approach —
 * no charting library. Colors use the app palette; all text meets contrast.
 *
 * Components:
 *  - BarChart      : horizontal labelled bars (counts/percentages)
 *  - FunnelChart   : a recruitment funnel (descending stage bars + drop-off)
 *  - DonutChart    : a single ratio as an SVG donut (e.g. conversion rate)
 */
import type { ReactNode } from 'react';

/** A category + numeric value, optionally a custom bar color + display value. */
export interface ChartDatum {
  label: string;
  value: number;
  /** Optional CSS color for the bar (defaults to the primary blue). */
  color?: string;
  /** Optional pre-formatted value label (defaults to the number). */
  display?: string;
}

const PALETTE = ['#0F1E3D', '#334766', '#5B7088', '#8CA0B8', '#B08542', '#A89E8E'];

/** Brand accent used to highlight the "this one matters" series (Prestige Gold). */
const ACCENT = '#B08542';

/** Pick a stable palette color by index. */
export function seriesColor(index: number): string {
  const safe = ((Math.trunc(index) % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[safe] ?? '#0F1E3D';
}

function pct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  const p = (value / max) * 100;
  return Math.max(0, Math.min(100, p));
}

/**
 * Horizontal bar chart. Each row is a label, a filled track, and a value. The
 * track width is relative to the largest value in the set.
 */
export function BarChart({ data, unit = '' }: { data: ChartDatum[]; unit?: string }) {
  if (data.length === 0) {
    return <div className="muted">Chưa có dữ liệu.</div>;
  }
  // Sort descending by value (largest first) for easy scanning; keep a copy so
  // callers' arrays aren't mutated.
  const sorted = data
    .map((d, originalIndex) => ({ ...d, originalIndex }))
    .sort((a, b) => (Number.isFinite(b.value) ? b.value : 0) - (Number.isFinite(a.value) ? a.value : 0));
  const max = Math.max(...sorted.map((d) => (Number.isFinite(d.value) ? d.value : 0)), 0);
  return (
    <div className="bar-chart">
      {sorted.map((d, i) => {
        // Single slate series; the top (largest) bar gets the gold accent so
        // the standout category is obvious. Explicit colors win.
        const fill = d.color ?? (i === 0 ? ACCENT : '#334766');
        return (
          <div className="bar-row" key={`${d.label}-${d.originalIndex}`}>
            <div className="bar-label" title={d.label}>
              {d.label}
            </div>
            <div
              className="bar-track"
              role="img"
              aria-label={`${d.label}: ${d.display ?? d.value}${unit}`}
              title={`${d.label}: ${d.display ?? d.value.toLocaleString()}${unit}`}
            >
              <div
                className="bar-fill"
                style={{ width: `${pct(d.value, max)}%`, background: fill }}
              />
            </div>
            <div className="bar-value">
              {d.display ?? d.value.toLocaleString()}
              {unit}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One stage of a funnel: a label, count, and percentage of the funnel total. */
export interface FunnelStage {
  label: string;
  count: number;
  /** Percent of the funnel top (0..100). */
  percentOfTotal: number;
}

/**
 * Funnel chart: descending bars, each showing the count + % of the total
 * entering the funnel, so drop-off between stages is visible at a glance.
 * Stage fills follow a navy → light-blue gradient; the stage with the worst
 * step-to-step drop-off is highlighted in gold.
 */
export function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  if (stages.length === 0) {
    return <div className="muted">Chưa có dữ liệu phễu.</div>;
  }

  // Identify the worst drop-off step (largest decrease from the previous stage)
  // so the operator's eye lands on the leakiest point in the pipeline.
  let worstIndex = -1;
  let worstDrop = 0;
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1];
    const cur = stages[i];
    if (!prev || !cur) continue;
    const drop = prev.percentOfTotal - cur.percentOfTotal;
    if (drop > worstDrop) {
      worstDrop = drop;
      worstIndex = i;
    }
  }

  // Navy gradient ramp across stages (navy → slate → light blue-gray).
  const RAMP = ['#0F1E3D', '#334766', '#5B7088', '#8CA0B8'];

  return (
    <div className="funnel">
      {stages.map((s, i) => {
        const isWorst = i === worstIndex;
        const fill = isWorst ? ACCENT : RAMP[Math.min(i, RAMP.length - 1)] ?? '#334766';
        return (
          <div className="funnel-stage" key={`${s.label}-${i}`}>
            <div className="funnel-meta">
              <span className="funnel-stage-label">{s.label}</span>
              <span className="funnel-stage-count">
                {s.count.toLocaleString()} · {s.percentOfTotal.toFixed(0)}%
                {isWorst ? ' · rớt nhiều nhất' : ''}
              </span>
            </div>
            <div
              className="funnel-bar-track"
              title={`${s.label}: ${s.count.toLocaleString()} ứng viên (${s.percentOfTotal.toFixed(0)}%)`}
            >
              <div
                className="funnel-bar-fill"
                style={{ width: `${Math.max(2, Math.min(100, s.percentOfTotal))}%`, background: fill }}
                role="img"
                aria-label={`${s.label}: ${s.count} (${s.percentOfTotal.toFixed(0)}%)`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * SVG donut showing a single ratio (0..100). `caption` renders under the value.
 * Stroke color defaults to the brand primary; pass a custom color for context.
 */
export function DonutChart({
  percent,
  caption,
  color = '#0F1E3D',
  size = 132,
}: {
  percent: number;
  caption?: ReactNode;
  color?: string;
  size?: number;
}) {
  const safe = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (safe / 100) * c;
  const center = size / 2;
  return (
    <div className="donut" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${safe.toFixed(0)}%`}>
        <circle cx={center} cy={center} r={r} fill="none" stroke="#E3DCD0" strokeWidth={stroke} />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${center} ${center})`}
        />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="donut-value">
          {safe.toFixed(0)}%
        </text>
      </svg>
      {caption ? <div className="donut-caption">{caption}</div> : null}
    </div>
  );
}
