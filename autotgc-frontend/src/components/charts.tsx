/**
 * Dependency-free chart primitives (pure SVG/CSS) for the analytics pages.
 * Kept intentionally small and consistent with the app's plain-CSS approach —
 * no charting library. Colors are read from the Design_Token_Layer (the :root
 * CSS variables in styles.css) so charts follow the Theme instead of using
 * literal hex; all text meets contrast.
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
  /** Optional CSS color for the bar (defaults to the primary navy token). */
  color?: string;
  /** Optional pre-formatted value label (defaults to the number). */
  display?: string;
}

/**
 * Resolve a CSS custom property from the Design_Token_Layer (`:root`) at
 * runtime, so chart colors track the active Theme. Falls back to the supplied
 * literal when the variable can't be read — e.g. server-side rendering, jsdom,
 * or before the global stylesheet is applied. The fallback mirrors the token's
 * value and is the only literal kept (no theme color is hardcoded as the
 * primary source).
 */
function readCssVar(token: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Series ramp expressed as Design_Token_Layer variables (navy → slate → gold →
 * warm neutrals), a single consistent ramp rather than a rainbow. Each entry is
 * a `[cssVar, fallback]` pair; the fallback mirrors the token value for non-DOM
 * environments.
 */
const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['--color-primary', '#0F1E3D'], // Academic Navy
  ['--color-secondary', '#334766'], // Slate Blue
  ['--color-gold', '#B08542'], // Prestige Gold
  ['--color-gold-text', '#87651F'], // deep gold
  ['--stone-500', '#82786A'], // warm gray
  ['--stone-400', '#A89E8E'], // light taupe
];

/** Brand accent used to highlight the "this one matters" series (Prestige Gold). */
function accentColor(): string {
  return readCssVar('--color-gold', '#B08542');
}

/** Pick a stable palette color by index, resolved from the Theme tokens. */
export function seriesColor(index: number): string {
  const safe = ((Math.trunc(index) % PALETTE.length) + PALETTE.length) % PALETTE.length;
  const entry: readonly [string, string] = PALETTE[safe] ?? ['--color-primary', '#0F1E3D'];
  return readCssVar(entry[0], entry[1]);
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
  const accent = accentColor();
  const slate = readCssVar('--color-secondary', '#334766');
  return (
    <div className="bar-chart">
      {sorted.map((d, i) => {
        // Single slate series; the top (largest) bar gets the gold accent so
        // the standout category is obvious. Explicit colors win.
        const fill = d.color ?? (i === 0 ? accent : slate);
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

  // Navy gradient ramp across stages (navy → slate → light blue-gray), read
  // from the Design_Token_Layer so the funnel tracks the active Theme.
  const RAMP: ReadonlyArray<string> = [
    readCssVar('--color-primary', '#0F1E3D'),
    readCssVar('--color-secondary', '#334766'),
    readCssVar('--stone-500', '#82786A'),
    readCssVar('--stone-400', '#A89E8E'),
  ];
  const accent = accentColor();

  return (
    <div className="funnel">
      {stages.map((s, i) => {
        const isWorst = i === worstIndex;
        const fill = isWorst ? accent : (RAMP[Math.min(i, RAMP.length - 1)] ?? accent);
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
 * Stroke color defaults to the brand primary token; pass a custom color for
 * context. The unfilled track uses the warm-stone token to match the Theme.
 */
export function DonutChart({
  percent,
  caption,
  color,
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
  // Default the arc to the navy primary token; the track to warm stone. Both
  // resolve from the Design_Token_Layer with literal fallbacks for non-DOM.
  const arcColor = color ?? readCssVar('--color-primary', '#0F1E3D');
  const trackColor = readCssVar('--stone-200', '#E3DCD0');
  return (
    <div className="donut" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${safe.toFixed(0)}%`}>
        <circle cx={center} cy={center} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={arcColor}
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
