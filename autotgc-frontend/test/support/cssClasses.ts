/**
 * Test-support: pure extraction of defined CSS class selectors, plus the
 * CLASS_CONTRACT — the set of class names pages and shared components depend on
 * (enumerated in design.md → Architecture → "Chiến lược bảo toàn hợp đồng
 * class-name"). Backs Property 7 (Feature: frontend-ui-redesign). Test-only.
 */

/**
 * Extract the set of class names that have at least one rule defined in `css`.
 *
 * Comments and the contents of `@keyframes` blocks are stripped first (so a
 * keyframe percentage / name is never mistaken for a class). Then every `.name`
 * token appearing in selector position is collected. A class counts as
 * "defined" if it appears anywhere as a `.class` selector token, including
 * compound (`.btn.btn-primary`), descendant (`.sidebar .conn`), pseudo
 * (`.tab--active:hover`) and attribute-qualified selectors.
 *
 * Pure: same input always yields an equal set.
 */
export function definedClasses(css: string): Set<string> {
  // Drop block comments.
  let cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Drop @keyframes blocks entirely (their bodies use `from`/`to`/`NN%`).
  cleaned = cleaned.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

  const classes = new Set<string>();
  // Class tokens are `.` followed by a valid CSS identifier (allowing escaped
  // chars is unnecessary for this contract). This matches selector usage; it
  // can also match inside declarations, but class-like `.foo` tokens do not
  // appear in property values in this stylesheet, so it is safe and total.
  const classRe = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(cleaned)) !== null) {
    classes.add(match[1]);
  }
  return classes;
}

/**
 * The preserved class-name contract. Sourced verbatim from design.md
 * (Architecture section) — the framing, block, data, stat, button/form, badge,
 * state and "other" groups. These names MUST keep at least one defining rule in
 * `src/styles.css` (Requirements 2.1, 2.3); they are restyled, never renamed.
 */
export const CLASS_CONTRACT: readonly string[] = [
  // ---- Khung (framing) ----
  'app-shell',
  'sidebar',
  'sidebar--collapsed',
  'sidebar--open',
  'sidebar-nav',
  'sidebar__group',
  'sidebar__label',
  'sidebar-link',
  'sidebar__footer',
  'sidebar__toggle',
  'sidebar-scrim',
  'main',
  'topbar',
  'topbar__search',
  'topbar__icon-btn',
  'content',
  'conn',
  'conn-dot',
  'bell',
  'bell-btn',
  'bell-panel',
  'user-chip',
  'role-pill',

  // ---- Khối (blocks) ----
  'card',
  'card--interactive',
  'card-title',
  'grid',
  'grid-2',
  'grid-4',
  'grid-kpi',
  'bento',
  'bento__feature',
  'bento__side',
  'bento__half',
  'page-header',
  'page-title',
  'section',
  'divider',
  'eyebrow',

  // ---- Dữ liệu (data tables) ----
  'data',
  'data--dense',
  'data--zebra',
  'data__num',
  'data__actions',
  'table-wrap',
  'pagination',

  // ---- Stat ----
  'stat',
  'stat--featured',
  'stat-label',
  'stat__label',
  'stat-value',
  'stat__value',
  'stat__delta',

  // ---- Nút / form (buttons / form) ----
  'btn',
  'btn-primary',
  'btn-secondary',
  'btn--ghost',
  'btn-blue',
  'btn-danger',
  'btn-sm',
  'btn--lg',
  'btn--icon',
  'field',
  'input',

  // ---- Badge ----
  'badge',
  'badge__dot',
  'badge-green',
  'badge-red',
  'badge-blue',
  'badge-yellow',
  'badge-gray',
  'badge--success',
  'badge--danger',
  'badge--info',
  'badge--warning',
  'badge--neutral',

  // ---- Trạng thái (states) ----
  'state',
  'error-box',
  'error-state',
  'notice',
  'success-box',
  'empty-state',
  'empty-state__title',
  'skeleton',
  'skeleton--row',
  'skeleton-stack',
  'spinner',

  // ---- Khác (other) ----
  'toolbar',
  'chip',
  'muted',
  'kv',
  'tabs',
  'tab',
  'tab--active',
  'step-row',
  'step-index',
  'bar-chart',
  'bar-row',
  'bar-track',
  'bar-fill',
  'bar-value',
  'funnel',
  'donut',
  'auth-wrap',
  'auth-card',
  'dnd-list',
  'dnd-row',
  'dnd-handle',
];
