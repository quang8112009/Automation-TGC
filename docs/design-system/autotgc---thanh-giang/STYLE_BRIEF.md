# STYLE BRIEF — AutoTGC (Thanh Giang)

> **Status:** Implementation-ready brief for the DESIGN subagent.
> **Authority:** This brief **operationalizes** `MASTER.md` (Data-Dense Dashboard) — it never contradicts it. All MASTER brand hexes are preserved exactly. Where `pages/dashboard.md` exists it still overrides both.
> **Stack constraint:** React 18 + Vite + **plain CSS** (no Tailwind). One stylesheet `autotgc-frontend/src/styles.css` driven by CSS custom properties. Product language: **Vietnamese**.
> **Scope:** Light mode only (dark mode noted as future consideration). No app code in this file.

---

## 1. North Star

AutoTGC is a **professional, data-dense control room for an XKLĐ (labor-export) marketing-automation business** — it must feel like the operator is flying a serious instrument, not browsing a brochure. The target feel is **Linear/Stripe/Vercel-grade**: calm neutral surfaces, a confident blue brand spine, one warm amber call-to-action that the eye always finds, dense-but-legible tables and KPI tiles, and zero ornament. Every pixel earns its place: maximum data visibility, generous-enough whitespace to scan in a Z-pattern, and instant trust through consistency, alignment, and restraint. Modern automation consoles win on *clarity under density* — they reduce cognitive load with strong hierarchy, contextual filtering, and quiet motion ([dashboard design principles, uxpilot](https://uxpilot.ai/blogs/dashboard-design-principles); [Geist/Vercel surfaces](https://vercel.com/geist/colors)). Content was rephrased for compliance with licensing restrictions.

---

## 2. Design Tokens — drop into CSS `:root`

> Keep MASTER's five brand hexes byte-for-byte. Everything else extends MASTER without conflict. Neutral ramp is the Slate family because MASTER already uses `#F8FAFC` (slate-50), `#E2E8F0` (slate-200), `#1E293B` (slate-800) — this just completes the ladder.

```css
:root {
  /* ---- Brand (MASTER — DO NOT CHANGE) ---- */
  --color-primary:        #1E40AF;  /* blue-800 — brand spine, primary surfaces, links */
  --color-primary-hover:  #1B3A9C;  /* darken ~6% for hover (derived) */
  --color-secondary:      #3B82F6;  /* blue-500 — secondary/info, chart series, focus */
  --color-cta:            #F59E0B;  /* amber-500 — THE primary action color */
  --color-cta-hover:      #D97706;  /* amber-600 — CTA hover (derived) */
  --color-background:     #F8FAFC;  /* app canvas */
  --color-text:           #1E3A8A;  /* blue-900 — headings/brand text (MASTER) */

  /* ---- Neutral ramp (Slate) ---- */
  --gray-50:  #F8FAFC;
  --gray-100: #F1F5F9;
  --gray-200: #E2E8F0;
  --gray-300: #CBD5E1;
  --gray-400: #94A3B8;
  --gray-500: #64748B;
  --gray-600: #475569;
  --gray-700: #334155;
  --gray-800: #1E293B;
  --gray-900: #0F172A;

  /* ---- Surfaces & borders ---- */
  --surface:         #FFFFFF;   /* cards, tables, modals sit on white above the canvas */
  --surface-raised:  #FFFFFF;   /* dropdowns/popovers (use shadow to lift, not color) */
  --surface-sunken:  #F8FAFC;   /* canvas / inset wells / zebra-alt */
  --surface-hover:   #F1F5F9;   /* row & item hover */
  --surface-active:  #EFF4FF;   /* selected nav/row tint (blue-50-ish) */
  --border:          #E2E8F0;   /* default hairline */
  --border-strong:   #CBD5E1;   /* dividers needing more presence */
  --sidebar-bg:      #0F172A;   /* deep slate spine — see §4 rationale */
  --sidebar-fg:      #CBD5E1;   /* idle nav label */
  --sidebar-fg-muted:#64748B;   /* section labels, collapsed hints */
  --sidebar-active-bg:#1E40AF;  /* active item = brand primary */
  --sidebar-active-fg:#FFFFFF;

  /* ---- Text roles ---- */
  --text-strong:  #0F172A;  /* primary reading text on white (max contrast) */
  --text-body:    #334155;  /* default body */
  --text-muted:   #64748B;  /* secondary / captions / table meta */
  --text-faint:   #94A3B8;  /* placeholders, disabled */
  --text-on-dark: #F8FAFC;  /* text on sidebar / primary fills */

  /* ---- Status (base / soft-bg / on-soft text) ---- */
  --success:       #22C55E;  --success-bg: #DCFCE7;  --success-fg: #15803D;
  --warning:       #F59E0B;  --warning-bg: #FEF3C7;  --warning-fg: #B45309;
  --danger:        #EF4444;  --danger-bg:  #FEE2E2;  --danger-fg:  #B91C1C;
  --info:          #3B82F6;  --info-bg:    #DBEAFE;  --info-fg:    #1D4ED8;
  --neutral:       #94A3B8;  --neutral-bg: #F1F5F9;  --neutral-fg: #475569;

  /* ---- Spacing (MASTER) ---- */
  --space-xs: 4px;  --space-sm: 8px;  --space-md: 16px;
  --space-lg: 24px; --space-xl: 32px; --space-2xl: 48px; --space-3xl: 64px;

  /* ---- Radius ---- */
  --radius-sm:  6px;    /* badges, small inputs, table chips */
  --radius-md:  8px;    /* buttons, inputs (MASTER) */
  --radius-lg:  12px;   /* cards (MASTER) */
  --radius-xl:  16px;   /* modals (MASTER) */
  --radius-pill:9999px; /* status pills, toggles */

  /* ---- Shadows (MASTER) ---- */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.10);
  --shadow-lg: 0 10px 15px rgba(0,0,0,0.10);
  --shadow-xl: 0 20px 25px rgba(0,0,0,0.15);
  --shadow-focus: 0 0 0 3px rgba(30,64,175,0.20); /* primary @ 20% — focus ring */

  /* ---- Typography ---- */
  --font-heading: 'Fira Code', ui-monospace, 'SFMono-Regular', monospace;
  --font-body:    'Fira Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono:    'Fira Code', ui-monospace, monospace; /* IDs, codes, metrics */

  --fs-display: 28px;  --lh-display: 36px;  /* page H1 (rare) */
  --fs-h1:      22px;  --lh-h1:      30px;  /* page title */
  --fs-h2:      18px;  --lh-h2:      26px;  /* card/section title */
  --fs-h3:      15px;  --lh-h3:      22px;  /* sub-section / table group */
  --fs-body:    14px;  --lh-body:    21px;  /* default UI text */
  --fs-sm:      13px;  --lh-sm:      18px;  /* table cells, dense */
  --fs-xs:      12px;  --lh-xs:      16px;  /* labels, badges, captions */
  --fs-kpi:     30px;  --lh-kpi:     36px;  /* KPI numbers (mono) */

  --fw-light:300; --fw-regular:400; --fw-medium:500; --fw-semibold:600; --fw-bold:700;

  /* ---- Motion ---- */
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --dur-fast: 150ms; --dur-base: 200ms; --dur-slow: 300ms;

  /* ---- Layout ---- */
  --sidebar-w:           256px;  /* expanded (16rem) */
  --sidebar-w-collapsed: 64px;   /* icon rail */
  --topbar-h:            56px;
  --content-max:         1440px; /* dense dashboards run wide; center beyond this */
  --content-pad:         24px;
}
```

> **Dark-mode note (future, not now):** the token structure (semantic `--surface`, `--text-*`, `--border`) is dark-ready. When added, remap surfaces to `--gray-900/800`, text to light, keep amber CTA, and brighten primary to `--color-secondary`. Do **not** implement now — app is light-mode.

---

## 3. Layout & Density

- **Shell:** fixed left sidebar + fixed top bar + scrolling content. Content area = `calc(100vw - var(--sidebar-w))`, top padding clears the 56px top bar.
- **Content max-width:** `1440px`, centered, `--content-pad: 24px` gutters. Dashboards may go full-bleed for wide tables; reading-heavy pages (Settings, Strategy) cap at ~`960px` for line length.
- **Grid:** 12-column conceptual grid, `gap: 24px`. KPI rows = 4 cards on ≥1280px, 2 on tablet, 1 on mobile (`repeat(auto-fit, minmax(220px, 1fr))`). Widget/bento area mixes tile spans (1×1 KPI, 2×1 chart, 2×2 table) ([bento grid dashboards, orbix](https://orbix.studio/blogs/bento-grid-dashboard-design-aesthetics)).
- **Spacing rhythm:** card padding `20–24px`; intra-card stack `12–16px`; section gap `24px`; page top→first-row `24px`. Keep breathing room — cramped dashboards overwhelm and information overload is the #1 dashboard failure ([uxpilot](https://uxpilot.ai/blogs/dashboard-design-principles)).
- **Reading order:** most-important KPI top-left, follow a Z-path for primary→secondary charts ([kindatechnical](https://kindatechnical.com/data-visualization/dashboard-layout-best-practices-and-design-patterns.html)).
- **Page header pattern (every page):** title (H1, mono) + optional breadcrumb/subtitle on the left; primary action button + secondary actions on the right; a thin `--border` divider under it; filters/toolbar sit directly below.
- **Section header:** H2 (Fira Sans 18/600) + optional muted helper text + right-aligned section action/“view all”.

---

## 4. Sidebar Spec

**Widths:** expanded **256px** (16rem), collapsed **64px** icon rail. These match the de-facto shadcn/ui convention (16rem default, icon rail) ([shadcn sidebar](https://ui.shadcn.com/docs/components/sidebar)). Mobile: off-canvas drawer 288px over a scrim.

**Surface:** deep slate `--sidebar-bg #0F172A`. Rationale: a dark spine makes the light content area pop, frames the data, and reads as “serious tool” (Linear/Vercel/Grafana convention) while keeping the page itself light per MASTER. Brand primary `#1E40AF` is reserved for the **active** item so the current location is unmistakable.

**Anatomy (top→bottom):**
1. **Brand/header** (logo mark + “AutoTGC” wordmark in Fira Code; wordmark hides when collapsed) — height = topbar 56px.
2. **Grouped nav** with small uppercase section labels (`--fs-xs`, `--fw-semibold`, `--sidebar-fg-muted`, letter-spacing .04em). Labels hide when collapsed (groups separated by a hairline divider instead).
3. **Footer (pinned):** collapse/expand toggle (`panel-left`/`chevrons-left`), data-sync/connection status dot, user menu (avatar + name + role badge ADMIN/SALES → `log-out`).

**Item states:**
- Idle: `--sidebar-fg`, icon stroke 1.75, label Fira Sans 14/500.
- Hover: bg `rgba(255,255,255,0.06)`, fg `#FFFFFF`, `--dur-fast`. **No layout shift.**
- Active: bg `--sidebar-active-bg`, fg `#FFFFFF`, plus a 3px amber left-accent bar (`--color-cta`) for a quick scan anchor.
- Focus-visible: `--shadow-focus` inset/outline.
- Collapsed: icon centered, label → tooltip on hover.

**Icon set:** **Lucide** (inline SVG, `viewBox="0 0 24 24"`, stroke `1.75`, rendered **18px** in sidebar, **16px** inline in tables/buttons). No emoji, ever (MASTER anti-pattern). Standardizing on Lucide matches the project skill’s icon library ([icons.csv → Lucide]).

**Grouping + icon map (existing 19 nav items → 5 groups):**

| Group (VN) | Item | Lucide icon |
|---|---|---|
| **Tổng quan** | Dashboard | `layout-dashboard` |
| **CRM tuyển dụng** | Leads | `user-plus` |
| | Đơn hàng | `clipboard-list` |
| | Ứng viên | `users` |
| | Phân tích tuyển dụng | `bar-chart-3` |
| **Marketing AI** | Strategy | `compass` |
| | Xu hướng | `trending-up` |
| | Insights | `lightbulb` |
| | Tư vấn AI | `bot` |
| | Autopilot | `plane` |
| | Workflows | `workflow` |
| **Nội dung** | Kế hoạch nội dung | `calendar-days` |
| | Xưởng nội dung | `pen-tool` |
| | Drafts | `file-text` |
| | Publishing | `send` |
| | Tài sản thương hiệu | `palette` |
| | Cơ sở tri thức | `book-open` |
| **Hệ thống** | Platform Tokens | `key` |
| | Settings | `settings` |

*Rationale:* Autopilot + Workflows + Insights + Strategy + Trends + AI consult form the “intelligence/automation engine” (Marketing AI); the content production pipeline (plan → studio → drafts → publish, plus brand assets + knowledge base) is grouped under Nội dung; CRM groups the recruitment lead lifecycle. Icons are unique within the rail (no two items share a glyph).

---

## 5. Component Redesign Notes

### Buttons (`.btn` preserved; add modifiers)
- **Primary = amber CTA** (`.btn` default or `.btn--primary`): bg `--color-cta`, text `#FFFFFF` (or `--gray-900` if contrast audit prefers — verify 4.5:1; on `#F59E0B` white passes for ≥semibold 14px, otherwise use `--gray-900`), `--radius-md`, padding `10px 16px`, `--fw-semibold`. Hover → `--color-cta-hover`, `--shadow-sm`. **No translate/scale** (MASTER forbids layout-shift hovers — replaces MASTER’s `translateY(-1px)` sample). Use color+shadow only.
- **Secondary = blue outline** (`.btn--secondary`): transparent bg, `1.5px` border `--color-primary`, text `--color-primary`. Hover → bg `--surface-active`.
- **Ghost** (`.btn--ghost`): no border, text `--text-body`; hover bg `--surface-hover`. For low-emphasis/toolbar actions.
- **Danger** (`.btn--danger`): bg `--danger`, white text; hover `--danger-fg`. Destructive only.
- **Sizes:** `.btn--sm` (`6px 12px`, `--fs-sm`), default (`10px 16px`), `.btn--lg` (`12px 20px`, `--fs-body`). Icon-only: square, `36px`, `aria-label` required.
- All buttons: `cursor:pointer`, `transition: background var(--dur-base), box-shadow var(--dur-base)`, focus `--shadow-focus`, disabled `opacity .5` + `cursor:not-allowed`.

### Cards (`.card` preserved)
- bg `--surface` (white, **not** MASTER’s `#F8FAFC` — white-on-canvas gives cleaner separation for data density), `--radius-lg`, border `1px --border`, padding `20–24px`, `--shadow-sm`.
- Hover **only if interactive** (clickable card): `--shadow-md`, border `--border-strong`. **Remove** MASTER’s `transform: translateY(-2px)` and blanket `cursor:pointer` — static info cards must not look clickable.
- Card header: H2 title + optional action; `12px` gap to body.

### KPI Stat Card (`.stat` preserved; add `.stat__*`)
Layout: small caps label (muted, `--fs-xs`) → big number (`--font-mono`, `--fs-kpi`, `--fw-semibold`, `--text-strong`) → trend delta row → optional sparkline.
- **Trend delta** (`.stat__delta`): inline icon + “+12,4%” + period caption. **Up = success green** (`--success-fg`) with `trending-up`; **down = danger red** (`--danger-fg`) with `trending-down`; **flat = neutral gray** with `minus`. This green-up/red-down convention is near-universal ([shadcn dashboard block](https://www.shadcn.io/blocks/dashboard-overview.mdx); [Davis stat-card](https://davis.libretexts.org/docs/components/stat-card)). For XKLĐ “cost/leak” metrics where down is good, allow `.stat__delta--invert` to swap colors — never let color lie about meaning.
- Optional 16–24px sparkline (secondary blue) at card foot. Count-up number animation allowed per dashboard override.

### Data Table (`table.data` preserved)
- Density: comfortable row height `44px`, dense variant `.data--dense` `36px`. Cell padding `10px 12px`, `--fs-sm`.
- **Sticky header:** `position:sticky; top:0`, bg `--gray-50`, text `--text-muted` uppercase `--fs-xs --fw-semibold`, bottom border `--border-strong`.
- **Rows:** white bg, `1px --border` row separators (prefer separators over zebra for scanning; zebra optional via `.data--zebra` using `--surface-sunken` on even rows — pick one, don’t combine).
- **Row hover:** bg `--surface-hover`, `--dur-fast`. Selected row: `--surface-active` + left amber accent.
- Numeric/ID/code columns → `--font-mono`, right-aligned for numbers.
- Status cells → badges (below). Row actions → ghost icon buttons revealed on hover (keep a visible affordance for touch).
- Provide sticky first column option for wide tables; horizontal scroll inside the card, never the page.

### Badges (`.badge` preserved; add status modifiers)
Pill (`--radius-pill`), `--fs-xs --fw-medium`, padding `2px 10px`, soft-bg + on-soft text:
- `.badge--success` (DCFCE7/15803D), `.badge--warning` (FEF3C7/B45309), `.badge--danger` (FEE2E2/B91C1C), `.badge--info` (DBEAFE/1D4ED8), `.badge--neutral` (F1F5F9/475569).
- Optional 6px leading status dot. Never encode status by color alone — always include the label text (a11y).

### Inputs / Selects (`.input` preserved)
- Height `38px`, padding `8px 12px`, `--fs-body`, border `1px --border`, `--radius-md`, bg `--surface`.
- Focus: border `--color-primary` + `--shadow-focus` (MASTER). Placeholder `--text-faint`.
- Error state: border `--danger` + helper text `--danger-fg`. Label `--fs-sm --fw-medium --text-body` above field.
- Selects/comboboxes use `chevron-down`; search inputs lead with `search` icon (16px, `--text-faint`).

### Modal (`.modal` / `.modal-overlay` preserved)
- Overlay `rgba(15,23,42,0.55)` + `backdrop-filter: blur(4px)` (MASTER). Panel bg `--surface`, `--radius-xl`, `--shadow-xl`, max-width `520px` (default) / `720px` (`.modal--lg`).
- Header (title + `x` close) / scrollable body / footer (right-aligned: ghost “Hủy” + primary action). Trap focus; `Esc` closes; return focus to trigger.

### Toolbar / Filters (`.toolbar` preserved)
- Horizontal bar under the page header: left = filter chips/selects + `search`; right = view toggles, `filter`, sort, density toggle, primary action.
- Filters always visible/accessible — MASTER explicitly forbids “no filtering”. Active filters render as removable chips (`x`).

### Page Header (new `.page-header`)
- Flex row: left `{breadcrumb?, H1 title (mono), subtitle?}`; right `{actions}`. Bottom hairline `--border`, `--space-lg` below.

### Tabs (new `.tabs` — useful for Strategy/Settings/detail pages)
- Underline style: row of buttons, active = `--color-primary` text + 2px bottom border `--color-primary`; idle `--text-muted`; hover `--text-body`. `--dur-fast` transition on the underline.

### Skeleton Loader (new `.skeleton`)
- bg `--gray-200`, `--radius-sm`, subtle shimmer (`@keyframes` left-right gradient, ~1.2s) — **gated behind `prefers-reduced-motion` (static gray if reduced)**. Use skeleton blocks shaped like the real content (KPI rows, table rows) instead of spinners for page/section loads; reserve `loader` spinner for in-button/async actions.
- **Empty state** (`.empty-state`): centered Lucide icon (32px, `--text-faint`) + one-line explanation + primary action. **Error state**: `alert-triangle` + message + retry.

---

## 6. Chart Guidance

General rules: label everything (axes, units, %, legend), sort comparisons descending, cap categorical palettes, animate entrance ≤300ms, provide hover tooltips, and offer a table fallback for accessibility ([charts.csv]; [kindatechnical](https://kindatechnical.com/data-visualization/dashboard-layout-best-practices-and-design-patterns.html)). Use a single coherent palette derived from the brand.

**Categorical series palette (in order):**
`#1E40AF` → `#3B82F6` → `#60A5FA` → `#F59E0B` → `#22C55E` → `#94A3B8`
(primary, secondary, light-blue, amber accent, green, neutral). Amber is the **highlight/“this one matters”** series, not a default.

| Chart | When | Spec & colors |
|---|---|---|
| **Funnel** (recruitment/lead conversion) | stage drop-off | Vertical/horizontal funnel, **label every stage + conversion %**. Gradient `--color-primary → --color-secondary` across stages; highlight the worst-drop stage with `--color-cta`. |
| **Horizontal bar** | compare categories (top platforms, sources) | **Sorted descending**, value labels at bar end, single color `--color-secondary`; highlight top/selected bar `--color-cta`. Gridlines `--border`. |
| **Donut** | one ratio (approval rate, capacity used) | Single ratio only, center shows the % in `--font-mono`. Filled arc `--color-primary` (or `--success` if “good”), track `--gray-200`. Avoid >4 slices — use stacked bar instead. |
| **Line / Area** | trends over time (leads/day, posts, metrics) | Line `--color-secondary` 2px; area fill `rgba(59,130,246,0.12)`. Multi-series use palette order. Forecast = dashed `--color-cta`. Markers on hover only. |
| **Sparkline** | inside KPI cards | 1.5px `--color-secondary`, no axes, last point dot. |

Axis/label text `--text-muted --fs-xs`; tooltip = white card, `--shadow-md`, `--radius-md`, mono numbers. Respect `prefers-reduced-motion` (skip count-up/draw animations).

---

## 7. Concrete CSS Approach

**Method:** single `styles.css`, all values via the `:root` tokens above. Refactor by **redefining the existing class rules to consume tokens** — do not rename or remove classes the ~22 pages depend on.

**MUST-PRESERVE class names (changing these breaks pages):**
`.card`, `.btn`, `.sidebar`, `table.data` (and `.data`), `.stat`, `.badge`, `.toolbar`, `.modal`, `.modal-overlay`, `.input`. Also preserve any existing button color modifiers already in use (e.g. `.btn-primary`, `.btn-secondary` from MASTER) — keep them as **aliases** mapping to the new token-based rules so old markup still renders correctly.

**NEW utility / modifier classes to add (additive, non-breaking):**
- Layout: `.app-shell`, `.sidebar--collapsed`, `.sidebar__group`, `.sidebar__label`, `.sidebar__item`, `.sidebar__item--active`, `.sidebar__footer`, `.topbar`, `.page`, `.page-header`, `.section`, `.grid-kpi`, `.grid-bento`.
- Buttons: `.btn--primary`, `.btn--secondary`, `.btn--ghost`, `.btn--danger`, `.btn--sm`, `.btn--lg`, `.btn--icon`.
- Stat: `.stat__label`, `.stat__value`, `.stat__delta`, `.stat__delta--up`, `.stat__delta--down`, `.stat__delta--flat`, `.stat__delta--invert`, `.stat__spark`.
- Table: `.data--dense`, `.data--zebra`, `.data__num`, `.data__actions`.
- Badges: `.badge--success|warning|danger|info|neutral`, `.badge__dot`.
- Feedback: `.skeleton`, `.skeleton--text`, `.skeleton--row`, `.empty-state`, `.error-state`, `.spinner`.
- Misc: `.tabs`, `.tab--active`, `.nav-icon`, `.muted`, `.mono`, `.kpi-num`, `.divider`, `.chip`, `.tooltip`.

**Global resets to add:** box-sizing border-box; `body { font-family: var(--font-body); font-size: var(--fs-body); line-height: var(--lh-body); color: var(--text-body); background: var(--color-background); }`; headings use `--font-heading`; `*:focus-visible { box-shadow: var(--shadow-focus); outline: none; }`; `@media (prefers-reduced-motion: reduce){ *{animation:none!important; transition:none!important;} }`.

**Icons:** add Lucide as inline SVG components (or `lucide-react`) in shared components; standardize a `.nav-icon`/`.icon` wrapper (16–18px, `currentColor`, stroke 1.75) so icons inherit text color. Remove any emoji icons.

---

## 8. Font Loading

Load **Fira Code** (headings/mono) + **Fira Sans** (body) via Google Fonts with `display=swap`. Put `<link>` tags in `autotgc-frontend/index.html` `<head>` (preferred over `@import` for performance — non-blocking + preconnect):

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

Weights to ship: Fira Sans 300/400/500/600/700; Fira Code 400/500/600/700. Vietnamese glyph coverage: both Fira families cover Vietnamese diacritics; Google’s `vietnamese` subset is served automatically. Keep `system-ui` fallbacks in the font tokens (already set) to avoid invisible-text flashes.

---

## 9. Do / Don’t (prioritized)

**DO**
1. Use the amber CTA for **exactly one** primary action per view; everything else is blue-outline/ghost. (Linear/Stripe single-emphasis discipline.)
2. Keep tables dense but legible: sticky header, hairline row separators, mono numerals right-aligned, row-hover tint.
3. Show trend deltas with green-up / red-down + arrow icon + period; allow inversion for cost metrics so color never lies ([shadcn block](https://www.shadcn.io/blocks/dashboard-overview.mdx)).
4. Lift with **shadow + border color** on hover; transitions 150–300ms (MASTER).
5. Drive *all* color/spacing/type from the `:root` tokens; reuse the preserved class names.
6. Use skeletons shaped like real content for loads; always provide empty/error states with a next action.
7. Keep filters visible and active filters as removable chips.
8. Maintain ≥4.5:1 text contrast; visible focus rings; respect `prefers-reduced-motion`; 44px touch targets.

**DON’T**
1. ❌ No emojis as icons — Lucide SVG only (MASTER).
2. ❌ No layout-shifting hovers (`scale`/`translateY` that nudge neighbors) — overrides MASTER’s sample button/card transforms (MASTER anti-pattern).
3. ❌ No `cursor:pointer` on non-interactive cards/elements (MASTER) — only true clickables.
4. ❌ Don’t combine zebra striping **and** row borders; don’t over-pad data tables.
5. ❌ Don’t use more than ~5–6 chart colors; no rainbow series; amber is a highlight, not a default.
6. ❌ No ornate decoration, gradients-as-skin, or drop-shadow stacking (MASTER: no ornate design).
7. ❌ Don’t cram everything on one screen — use grouping, tabs, and progressive disclosure to fight information overload ([uxpilot](https://uxpilot.ai/blogs/dashboard-design-principles)).
8. ❌ Don’t hide content behind the fixed top bar; no horizontal scroll on the page (scroll inside table cards instead).
9. ❌ Don’t introduce a second font family or non-token hex values.

---

*Sources (paraphrased; rephrased for licensing compliance): [shadcn/ui sidebar](https://ui.shadcn.com/docs/components/sidebar) · [shadcn dashboard block](https://www.shadcn.io/blocks/dashboard-overview.mdx) · [Vercel Geist colors](https://vercel.com/geist/colors) · [uxpilot dashboard principles](https://uxpilot.ai/blogs/dashboard-design-principles) · [kindatechnical dashboard layout](https://kindatechnical.com/data-visualization/dashboard-layout-best-practices-and-design-patterns.html) · [orbix bento grid](https://orbix.studio/blogs/bento-grid-dashboard-design-aesthetics) · [Davis stat-card](https://davis.libretexts.org/docs/components/stat-card) · project skill data: icons.csv, charts.csv, colors.csv, typography.csv.*
